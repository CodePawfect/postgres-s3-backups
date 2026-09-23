import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

async function runBackup(t, { dumpExit = 0, restoreExit = 0, uploadFails = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  const temporary = path.join(directory, "temporary");
  await mkdir(bin);
  await mkdir(temporary);
  await writeFile(path.join(bin, "pg_dump"), '#!/bin/sh\n[ "$1" = "--dbname=$PGDATABASE" ] || exit 2\nprintf "mock PostgreSQL archive"\nexit "$MOCK_DUMP_EXIT"\n', { mode: 0o755 });
  await writeFile(path.join(bin, "pg_restore"), '#!/bin/sh\ncat > /dev/null\nexit "$MOCK_RESTORE_EXIT"\n', { mode: 0o755 });

  const calls = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    calls.push({ method: request.method, path: url.pathname, versions: url.searchParams.has("versions") });
    request.resume();
    request.on("end", () => {
      if (request.method === "PUT") {
        if (uploadFails) {
          response.writeHead(403, { "Content-Type": "application/xml" });
          response.end('<Error><Code>AccessDenied</Code><Message>storage cap exceeded</Message></Error>');
        } else {
          response.writeHead(200, { ETag: '"test-etag"' });
          response.end();
        }
      } else if (url.searchParams.has("versions")) {
        const key = calls.find((call) => call.method === "PUT").path.slice("/test-bucket/".length);
        response.writeHead(200, { "Content-Type": "application/xml" });
        response.end(`<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><Version><Key>${key}</Key><VersionId>uploaded-version</VersionId><IsLatest>true</IsLatest><LastModified>${new Date().toISOString()}</LastModified><Size>100</Size></Version></ListVersionsResult>`);
      } else {
        response.writeHead(500);
        response.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  let result;
  try {
    result = await run(process.execPath, ["dist/index.js"], {
      timeout: 15000,
      env: {
        PATH: `${bin}:${process.env.PATH}`, TMPDIR: temporary,
        AWS_ACCESS_KEY_ID: "test-access", AWS_SECRET_ACCESS_KEY: "test-secret",
        AWS_S3_BUCKET: "test-bucket", AWS_S3_REGION: "test-region",
        AWS_S3_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
        AWS_S3_FORCE_PATH_STYLE: "true", BACKUP_DATABASE_URL: "postgresql://test:never-print-this@localhost/test",
        BACKUP_RETENTION_COUNT: "20", BACKUP_RETENTION_DRY_RUN: "false",
        SINGLE_SHOT_MODE: "true", MOCK_DUMP_EXIT: String(dumpExit), MOCK_RESTORE_EXIT: String(restoreExit),
      },
    });
    result.code = 0;
  } catch (error) {
    result = error;
  }
  assert.deepEqual(await readdir(temporary), [], "temporary archive must be removed on success and failure");
  assert.ok(!(result.stdout + result.stderr).includes("never-print-this"), "database credentials must not reach logs");
  return { result, calls };
}

test("partial pg_dump output with a failure never uploads or prunes", async (t) => {
  const { result, calls } = await runBackup(t, { dumpExit: 1 });
  assert.equal(result.code, 1);
  assert.equal(calls.length, 0);
  assert.match(result.stderr, /no backup was uploaded or pruned/);
});

test("a gzip containing an invalid PostgreSQL archive never uploads or prunes", async (t) => {
  const { result, calls } = await runBackup(t, { restoreExit: 1 });
  assert.equal(result.code, 1);
  assert.equal(calls.length, 0);
});

test("storage-cap upload failure never reaches retention", async (t) => {
  const { result, calls } = await runBackup(t, { uploadFails: true });
  assert.equal(result.code, 1);
  assert.deepEqual(calls.map((call) => call.method), ["PUT"]);
});

test("validated successful upload is followed by retention listing", async (t) => {
  const { result, calls } = await runBackup(t);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(calls.map((call) => call.method), ["PUT", "GET"]);
  assert.equal(calls[1].versions, true);
  assert.match(result.stdout, /DB backup complete/);
});
