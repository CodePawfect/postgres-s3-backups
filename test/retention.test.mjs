import assert from "node:assert/strict";
import test from "node:test";
import { parseRetentionCount, pruneBackups } from "../dist/retention.js";

function version(index, overrides = {}) {
  const date = new Date(Date.UTC(2026, 8, 1, index));
  return {
    Key: `backup-${date.toISOString().replace(/[:.]+/g, "-")}.tar.gz`,
    VersionId: `version-${index}`,
    LastModified: date,
    Size: 100,
    IsLatest: true,
    ...overrides,
  };
}

function clientFor(pages, deletionResult) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      if (command.constructor.name === "ListObjectVersionsCommand") {
        const page = pages.shift();
        if (page instanceof Error) throw page;
        assert.ok(page, "unexpected extra listing request");
        return page;
      }
      assert.equal(command.constructor.name, "DeleteObjectsCommand");
      return deletionResult ?? { Deleted: command.input.Delete.Objects };
    },
  };
}

const options = (overrides = {}) => ({
  bucket: "test-bucket", filePrefix: "backup", subfolder: "", count: 20,
  uploadedKey: version(22).Key, dryRun: false, ...overrides,
});
const deletions = (client) => client.calls.filter((call) => call.constructor.name === "DeleteObjectsCommand");

test("retention count rejects values that could accidentally remove all backups", () => {
  for (const input of ["-1", "1.5", "", "NaN", "Infinity", "1e3", "20days", "9007199254740992"]) {
    assert.throws(() => parseRetentionCount(input));
  }
  assert.equal(parseRetentionCount("0"), 0);
  assert.equal(parseRetentionCount("20"), 20);
});

test("disabled retention does not even list the bucket", async () => {
  const client = clientFor([]);
  await pruneBackups(client, options({ count: 0 }));
  assert.equal(client.calls.length, 0);
});

test("loads every page, protects newest 20, and permanently removes every version of old keys", async () => {
  const backups = Array.from({ length: 23 }, (_, index) => version(index));
  const client = clientFor([
    { Versions: [...backups.slice(0, 12), version(1, { VersionId: "older-version", IsLatest: false })], IsTruncated: true, NextKeyMarker: "next-key", NextVersionIdMarker: "next-version" },
    { Versions: backups.slice(12).reverse(), IsTruncated: false },
  ]);
  await pruneBackups(client, options());
  assert.equal(client.calls[1].input.KeyMarker, "next-key");
  assert.equal(client.calls[1].input.VersionIdMarker, "next-version");
  assert.deepEqual(client.calls.map((call) => call.constructor.name), ["ListObjectVersionsCommand", "ListObjectVersionsCommand", "DeleteObjectsCommand"]);
  assert.deepEqual(new Set(deletions(client)[0].input.Delete.Objects.map((item) => item.VersionId)), new Set(["version-0", "version-1", "version-2", "older-version"]));
  assert.ok(deletions(client)[0].input.Delete.Objects.every((item) => item.Key && item.VersionId));
});

test("exact scope protects other databases, nested paths, manual files and invalid dates", async () => {
  const prefix = "production/backup.v1-";
  const matching = Array.from({ length: 23 }, (_, index) => version(index, { Key: version(index).Key.replace("backup-", prefix) }));
  const outsiders = [
    version(-1), version(-2, { Key: "production/backupXv1-2026-08-01T00-00-00-000Z.tar.gz" }),
    version(-3, { Key: "production/backup.v1-manual.tar.gz" }),
    version(-4, { Key: "production/nested/backup.v1-2026-08-01T00-00-00-000Z.tar.gz" }),
    version(-5, { Key: "production/backup.v1-2026-02-31T00-00-00-000Z.tar.gz" }),
  ];
  const client = clientFor([{ Versions: [...outsiders, ...matching], IsTruncated: false }]);
  await pruneBackups(client, options({ filePrefix: "backup.v1", subfolder: "production", uploadedKey: matching[22].Key }));
  assert.equal(client.calls[0].input.Prefix, prefix);
  assert.deepEqual(new Set(deletions(client)[0].input.Delete.Objects.map((item) => item.Key)), new Set(matching.slice(0, 3).map((item) => item.Key)));
});

test("dry run lists and calculates but does not delete", async () => {
  const client = clientFor([{ Versions: Array.from({ length: 23 }, (_, i) => version(i)), IsTruncated: false }]);
  await pruneBackups(client, options({ dryRun: true }));
  assert.equal(deletions(client).length, 0);
});

test("an upload absent from the protected set blocks all deletion", async () => {
  for (const uploadedKey of ["missing.tar.gz", version(0).Key]) {
    const client = clientFor([{ Versions: Array.from({ length: 23 }, (_, i) => version(i)), IsTruncated: false }]);
    await assert.rejects(pruneBackups(client, options({ uploadedKey })), /New backup is missing/);
    assert.equal(deletions(client).length, 0);
  }
});

test("a failing later page does not delete anything from earlier pages", async () => {
  const client = clientFor([
    { Versions: Array.from({ length: 23 }, (_, i) => version(i)), IsTruncated: true, NextKeyMarker: "next" },
    new Error("list access denied"),
  ]);
  await assert.rejects(pruneBackups(client, options()), /list access denied/);
  assert.equal(deletions(client).length, 0);
});

test("incomplete or cycling pagination fails closed", async () => {
  for (const pages of [
    [{ Versions: [version(22)] }],
    [{ IsTruncated: true }],
    [{ IsTruncated: true, NextKeyMarker: "same" }, { IsTruncated: true, NextKeyMarker: "same" }],
  ]) {
    const client = clientFor(pages);
    await assert.rejects(pruneBackups(client, options()), /listing/);
    assert.equal(deletions(client).length, 0);
  }
});

test("missing version IDs or timestamps fail closed", async () => {
  for (const change of [{ VersionId: undefined }, { LastModified: undefined }, { LastModified: new Date("invalid") }, { Size: undefined }, { IsLatest: undefined }]) {
    const client = clientFor([{ Versions: [version(0, change), version(22)], IsTruncated: false }]);
    await assert.rejects(pruneBackups(client, options()), /Incomplete backup metadata/);
    assert.equal(deletions(client).length, 0);
  }
});

test("zero-byte and hidden keys do not consume restore points or become deletion targets", async () => {
  const client = clientFor([{ Versions: [version(0, { Size: 0 }), version(1, { IsLatest: false }), version(22)], IsTruncated: false }]);
  await pruneBackups(client, options({ count: 1 }));
  assert.equal(deletions(client).length, 0);
});

test("fewer than the desired number never causes deletion", async () => {
  const client = clientFor([{ Versions: [version(1), version(22)], IsTruncated: false }]);
  await pruneBackups(client, options());
  assert.equal(deletions(client).length, 0);
});

test("batches at 1000 and reports partial deletion failures", async () => {
  const versions = Array.from({ length: 1022 }, (_, index) => version(index));
  const client = clientFor([{ Versions: versions, IsTruncated: false }]);
  await pruneBackups(client, options({ uploadedKey: version(1021).Key }));
  assert.deepEqual(deletions(client).map((call) => call.input.Delete.Objects.length), [1000, 2]);
  const denied = clientFor([{ Versions: versions, IsTruncated: false }], { Errors: [{ Code: "AccessDenied" }] });
  await assert.rejects(pruneBackups(denied, options({ uploadedKey: version(1021).Key })), /retention failed/);
  assert.equal(deletions(denied).length, 1);
});

test("missing delete confirmations are not reported as success", async () => {
  const client = clientFor([{ Versions: [version(0), version(22)], IsTruncated: false }], {});
  await assert.rejects(pruneBackups(client, options({ count: 1 })), /could not be fully confirmed/);
});
