import { execFile, spawn } from "child_process";
import { S3Client, S3ClientConfig, PutObjectCommandInput } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream, createWriteStream, statSync } from "fs";
import { rm } from "fs/promises";
import { filesize } from "filesize";
import path from "path";
import os from "os";
import { promisify } from "util";
import { once } from "events";
import { pipeline } from "stream/promises";
import { createGzip } from "zlib";

import { env } from "./env.js";
import { createMD5 } from "./util.js";
import { pruneBackups } from "./retention.js";

const runCommand = promisify(execFile);

const uploadToS3 = async ({ name, path }: { name: string, path: string }) => {
  console.log("Uploading backup to S3...");

  const bucket = env.AWS_S3_BUCKET;

  const clientOptions: S3ClientConfig = {
    region: env.AWS_S3_REGION,
    forcePathStyle: env.AWS_S3_FORCE_PATH_STYLE
  }

  if (env.AWS_S3_ENDPOINT) {
    console.log(`Using custom endpoint: ${env.AWS_S3_ENDPOINT}`);

    clientOptions.endpoint = env.AWS_S3_ENDPOINT;
  }

  if (env.BUCKET_SUBFOLDER) {
    name = env.BUCKET_SUBFOLDER + "/" + name;
  }

  let params: PutObjectCommandInput = {
    Bucket: bucket,
    Key: name,
    Body: createReadStream(path),
  }

  if (env.SUPPORT_OBJECT_LOCK) {
    console.log("MD5 hashing file...");

    const md5Hash = await createMD5(path);

    console.log("Done hashing file");

    params.ContentMD5 = Buffer.from(md5Hash, 'hex').toString('base64');
  }

  const client = new S3Client(clientOptions);

  try {
    await new Upload({ client, params }).done();
    console.log("Backup uploaded to S3...");
    await pruneBackups(client, {
      bucket,
      filePrefix: env.BACKUP_FILE_PREFIX,
      subfolder: env.BUCKET_SUBFOLDER,
      count: env.BACKUP_RETENTION_COUNT,
      uploadedKey: name,
      dryRun: env.BACKUP_RETENTION_DRY_RUN,
    });
  } finally {
    client.destroy();
  }
}

const dumpToFile = async (filePath: string) => {
  console.log("Dumping DB to file...");

  // Keep the database URL out of command text and error logs. Check pg_dump's
  // exit status separately from compression so partial output cannot trigger retention.
  const options = { env: { ...process.env, PGDATABASE: env.BACKUP_DATABASE_URL, BACKUP_OUTPUT: filePath } };
  try {
    const dump = spawn("sh", ["-c", `exec pg_dump --dbname="$PGDATABASE" --format=tar ${env.BACKUP_OPTIONS}`], {
      ...options, stdio: ["ignore", "pipe", "pipe"],
    });
    let warnings = false;
    dump.stderr.on("data", () => { warnings = true; });
    const exited = once(dump, "close").then(([code]) => {
      if (code !== 0) throw new Error("pg_dump failed");
    });
    const compressed = pipeline(dump.stdout, createGzip(), createWriteStream(filePath));
    try {
      await Promise.all([exited, compressed]);
    } catch {
      dump.kill();
      await Promise.allSettled([exited, compressed]);
      throw new Error("Dump or compression failed");
    }
    if (warnings) console.warn("pg_dump reported warnings; verify backup contents before relying on this restore point");
    await runCommand("gzip", ["-t", filePath]);
    // pg_restore --list may stop reading after the table of contents. gzip -t
    // above checks the full compressed file independently of that early exit.
    await runCommand("sh", ["-c", 'gzip -cd "$BACKUP_OUTPUT" | pg_restore --list > /dev/null'], options);
  } catch {
    throw new Error("Database dump or archive validation failed; no backup was uploaded or pruned");
  }

  console.log("Backup archive file is valid");
  console.log("Backup filesize:", filesize(statSync(filePath).size));
  console.log("DB dumped to file...");
}

export const backup = async () => {
  console.log("Initiating DB backup...");

  const date = new Date().toISOString();
  const timestamp = date.replace(/[:.]+/g, '-');
  const filename = `${env.BACKUP_FILE_PREFIX}-${timestamp}.tar.gz`;
  const filepath = path.join(os.tmpdir(), filename);

  try {
    await dumpToFile(filepath);
    await uploadToS3({ name: filename, path: filepath });
  } finally {
    await rm(filepath, { force: true });
  }

  console.log("DB backup complete...");
}
