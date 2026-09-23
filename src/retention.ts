import { DeleteObjectsCommand, ListObjectVersionsCommand, ObjectVersion, S3Client } from "@aws-sdk/client-s3";

export const parseRetentionCount = (value: string): number => {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("BACKUP_RETENTION_COUNT must be a non-negative integer");
  }
  return Number(value);
};

export type RetentionOptions = {
  bucket: string;
  filePrefix: string;
  subfolder: string;
  count: number;
  uploadedKey: string;
  dryRun: boolean;
};

type BackupVersion = { Key: string; VersionId: string; LastModified: Date; Size: number; IsLatest: boolean };

const backupPattern = (prefix: string) => {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})-(\\d{3})Z\\.tar\\.gz$`);
};

const matchingVersions = (versions: ObjectVersion[], prefix: string): BackupVersion[] => {
  const pattern = backupPattern(prefix);
  return versions.flatMap((version) => {
    const match = pattern.exec(version.Key ?? "");
    if (!match) return [];
    const timestamp = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== timestamp) return [];
    if (!version.VersionId || !version.LastModified || !Number.isFinite(version.LastModified.getTime()) ||
        !Number.isSafeInteger(version.Size) || version.Size! < 0 || typeof version.IsLatest !== "boolean") {
      throw new Error("Incomplete backup metadata; retention aborted without deleting anything");
    }
    return [version as BackupVersion];
  });
};

/** Only called after a validated dump has been successfully uploaded. */
export const pruneBackups = async (client: Pick<S3Client, "send">, options: RetentionOptions) => {
  if (!Number.isSafeInteger(options.count) || options.count < 0) {
    throw new Error("Invalid backup retention count");
  }
  if (options.count === 0) return;

  const prefix = `${options.subfolder ? options.subfolder + "/" : ""}${options.filePrefix}-`;
  const versions: ObjectVersion[] = [];
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  const seenCursors = new Set<string>();

  // Finish every page before deciding which backups are safe to remove.
  while (true) {
    const page = await client.send(new ListObjectVersionsCommand({
      Bucket: options.bucket,
      Prefix: prefix,
      KeyMarker: keyMarker,
      VersionIdMarker: versionMarker,
      MaxKeys: 1000,
    }));
    versions.push(...(page.Versions ?? []));
    if (page.IsTruncated === false) break;
    if (page.IsTruncated !== true || !page.NextKeyMarker) {
      throw new Error("Incomplete backup listing; retention aborted without deleting anything");
    }
    const cursor = JSON.stringify([page.NextKeyMarker, page.NextVersionIdMarker]);
    if (seenCursors.has(cursor)) {
      throw new Error("Backup listing cursor repeated; retention aborted without deleting anything");
    }
    seenCursors.add(cursor);
    keyMarker = page.NextKeyMarker;
    versionMarker = page.NextVersionIdMarker;
  }

  const backups = matchingVersions(versions, prefix);
  const latest = backups.filter((version) => version.IsLatest && version.Size > 0)
    .sort((a, b) => b.LastModified.getTime() - a.LastModified.getTime() || b.Key.localeCompare(a.Key));
  if (new Set(latest.map((version) => version.Key)).size !== latest.length) {
    throw new Error("Ambiguous backup listing; retention aborted without deleting anything");
  }
  const kept = new Set(latest.slice(0, options.count).map((version) => version.Key));
  if (!kept.has(options.uploadedKey)) {
    throw new Error("New backup is missing from the retained set; retention aborted without deleting anything");
  }

  const oldKeys = new Set(latest.slice(options.count).map((version) => version.Key));
  const expired = backups.filter((version) => oldKeys.has(version.Key));
  const bytes = expired.reduce((sum, version) => sum + version.Size, 0);
  console.log(`Backup retention${options.dryRun ? " (dry run)" : ""}: keep ${kept.size} backups; remove ${oldKeys.size} backups / ${expired.length} versions / ${bytes} bytes`);
  if (options.dryRun) return;

  // A key-only delete merely hides a B2 object. Delete the exact old versions to reclaim storage.
  for (let offset = 0; offset < expired.length; offset += 1000) {
    const batch = expired.slice(offset, offset + 1000).map(({ Key, VersionId }) => ({ Key, VersionId }));
    const result = await client.send(new DeleteObjectsCommand({
      Bucket: options.bucket,
      Delete: { Objects: batch, Quiet: false },
    }));
    if (result.Errors?.length) {
      throw new Error(`Backup retention failed for ${result.Errors.length} object versions; the newest ${kept.size} backups were excluded from deletion`);
    }
    const deleted = new Set((result.Deleted ?? []).map(({ Key, VersionId }) => JSON.stringify([Key, VersionId])));
    if (batch.some(({ Key, VersionId }) => !deleted.has(JSON.stringify([Key, VersionId])))) {
      throw new Error("Backup retention deletion could not be fully confirmed");
    }
  }
};
