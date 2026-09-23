# Postgres S3 backups

A simple NodeJS application to backup your PostgreSQL database to S3 via a cron.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/I4zGrH)

## Configuration

- `AWS_ACCESS_KEY_ID` - AWS access key ID.

- `AWS_SECRET_ACCESS_KEY` - AWS secret access key, sometimes also called an application key.

- `AWS_S3_BUCKET` - The name of the bucket that the access key ID and secret access key are authorized to access.

- `AWS_S3_REGION` - The name of the region your bucket is located in, set to `auto` if unknown.

- `BACKUP_DATABASE_URL` - The connection string of the database to backup.

- `BACKUP_CRON_SCHEDULE` - The cron schedule in UTC. Example: `0 2 * * *` runs once daily at 02:00 UTC.

- `BACKUP_RETENTION_COUNT` - Keep this many successfully uploaded backups for the configured file prefix and subfolder. Default `0` disables cleanup. Requires an S3 provider supporting `ListObjectVersions` and version-specific deletion (including Backblaze B2).

- `BACKUP_RETENTION_DRY_RUN` - Report what retention would remove without deleting anything. Default `true`. Set to `false` only after reviewing the bucket contents and count.

- `AWS_S3_ENDPOINT` - The S3 custom endpoint you want to use. Applicable for 3-rd party S3 services such as Cloudflare R2 or Backblaze R2.

- `AWS_S3_FORCE_PATH_STYLE` - Use path style for the endpoint instead of the default subdomain style, useful for MinIO. Default `false`

- `RUN_ON_STARTUP` - Run a backup on startup of this application then proceed with making backups on the set schedule.

- `BACKUP_FILE_PREFIX` - Add a prefix to the file name.

- `BUCKET_SUBFOLDER` - Define a subfolder to place the backup files in.

- `SINGLE_SHOT_MODE` - Run a single backup on start and exit when completed. Useful with the platform's native CRON schedular.

- `SUPPORT_OBJECT_LOCK` - Enables support for buckets with object lock by providing an MD5 hash with the backup file.

- `BACKUP_OPTIONS` - Add any valid pg_dump option, supported pg_dump options can be found [here](https://www.postgresql.org/docs/current/app-pgdump.html). Example: `--exclude-table=pattern`

- `NODE_VERSION` - Specify a custom Node.js version to override the default version set in the Dockerfile.

- `PG_VERSION` - Specify a custom PostgreSQL version to override the default version set in the Dockerfile.

## Notes for Postgres 17

If backing up a Postgres 17 database imported from Postgres 16, set `PG_VERSION=17` and `NODE_VERSION=22`.

## Daily backups with count-based retention

For 20 restore points, use `BACKUP_CRON_SCHEDULE=0 2 * * *` and `BACKUP_RETENTION_COUNT=20`.
Review the dry-run summary, then set `BACKUP_RETENTION_DRY_RUN=false` to enable deletion.
Only timestamped `.tar.gz` files matching this service's exact prefix and subfolder are managed.
Use a separate prefix or subfolder for each database and run only one writer for that scope.
Manual/startup backups also count toward the limit; 20 backups are not necessarily 20 calendar days.

Cleanup runs only after `pg_dump` succeeds, the gzip and PostgreSQL archive checks pass, and
the upload completes. These structural checks do not replace periodic restore tests.
The full paginated version listing must contain the newly uploaded backup in the retained
set before any deletion starts. Listing failures, missing version metadata, invalid settings,
and upload failures never trigger deletion. All versions of expired backup keys are deleted
by version ID, so Backblaze frees their storage instead of only adding delete markers.
Unrelated files, already hidden keys, and all versions of retained keys are left untouched.
Partial deletion failures are reported as failed runs; the retained set is never targeted.

The service key needs permission to list object versions and delete object versions in the
backup scope in addition to uploading backups. Buckets with object retention/holds may reject
deletion; this service does not bypass them. Providers without version-listing support can
continue running with retention disabled.

If the bucket is already at its storage cap, the first new upload cannot succeed. Review a
one-off cleanup manifest and free space before restarting. When moving from hourly to daily
backups, keep one successful backup per day for the last 20 available days during this initial
cleanup; simply keeping the last 20 hourly files would preserve less than one day of history.
Backblaze's "keep prior versions" lifecycle option alone cannot expire timestamped files,
because every backup has a new key. See [Backblaze lifecycle rules](https://www.backblaze.com/docs/cloud-storage-lifecycle-rules).

Run `npm run typecheck` and `npm test` before deployment. Test deletion paths use a mock S3
client or a local server and never access a real bucket.
