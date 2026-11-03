# Backup and restore

NoConBrain keeps three kinds of data, and a backup has to cover all of them.

| What | Where | In the backup folder? |
|---|---|---|
| Databases: pages, versions, sources, settings, accounts, job queue, knowledge-package list | `/data/db/main.db` | Yes, always |
| Search index | `/data/index/index.db` | Only if you ask. It is rebuilt from the archive after a restore |
| Secret key (decrypts stored search-provider keys) | `/data/secrets/secret.key`, or `NCB_SECRET_KEY` | Only if you ask. Keep it apart from the backup |
| Saved files: page content, images, stylesheets, copied knowledge packages | the storage volumes, for example `/volumes/default` | No. Copy them yourself (see below) |

Never copy `main.db` while the server runs. It is in WAL mode, so a plain file copy can be torn. Use the backup tool, which uses SQLite's `VACUUM INTO` and checks the copy before it counts.

## What happens automatically

Once a day (`NCB_BACKUP_INTERVAL_HOURS`, default 24) the server writes a backup into `/data/backups/backup-<date>T<time>Z/` and keeps the newest seven (`NCB_BACKUP_KEEP`). A backup folder holds `main.db` and `manifest.json`. The manifest lists each file with its SHA-256, the number of pages, and where each storage volume lives. The folder is built under a hidden temporary name and renamed when complete, so a crash never leaves something that looks like a finished backup.

Once a week (`NCB_VERIFY_INTERVAL_HOURS`, default 168) the server runs a full read-only verify of the archive, and once a day a quick database integrity check. Finished jobs older than seven days (`NCB_JOB_RETENTION_DAYS`) are rolled into daily counters, and the activity log is trimmed to its retention (`NCB_ACTIVITY_LOG_RETENTION_DAYS`, default 30). All of it shows in the activity log, and each backup and verify appears as a maintenance run. Set an interval to `0` to turn that job off.

`/data/backups` is on the same disk as the data. A backup on the same disk protects against a bad upgrade or a mistake, not against losing the disk. Copy it elsewhere.

## Take a backup now

Settings, Storage, Maintenance, or the API:

```sh
curl -X POST -H 'x-nocon-csrf: 1' -H 'Origin: http://localhost:3000' -b cookies.txt \
  -H 'content-type: application/json' -d '{"includeIndex":false,"includeSecretKey":true}' \
  http://localhost:3000/api/system/maintenance/backup
```

`includeSecretKey: true` puts `secret.key` in the folder. Do that only if you will store the backup somewhere as private as the server itself.

## A complete backup, step by step

1. Write the database backup (above). Do this first.
2. Copy the storage volumes. Saved files never change once written, so you can copy them while the server runs:
   `rsync -a /mnt/ssd/ncb/ /mnt/backup/ncb-volume/`
   Because the database was copied first, the volume copy holds at least every file the database refers to. Extra files are harmless; verify files them as strays.
3. Copy `/data/backups/backup-…` to the same place.
4. Store the secret key separately. If you lose it, nothing else is lost: provider API keys have to be entered again.

With Docker Compose, `docker compose cp server:/data/backups ./backups` copies the backup folders out.

## Restore

You need the backup folder and the storage volumes. Restore the volumes to the same paths the old server used (the manifest lists them), because the database stores absolute paths.

1. Stop the server: `docker compose stop server web`.
2. Put the storage volumes back at their old paths.
3. Restore the database into an empty data directory. With Compose, run the tool in a one-off container that shares the data volume:

   ```sh
   docker compose run --rm --no-deps server node dist/cli.js restore /data/backups/backup-20261103T020000Z
   ```

   Without Docker: `node apps/server/dist/cli.js restore <backup folder> --data-dir <data dir>`.

   The tool checks every file against the manifest and runs `PRAGMA integrity_check` before it changes anything. It refuses if a server is running, if the data directory already has a database (add `--force` to replace it, and the old one is kept as `main.db.before-restore-…`), or if a file is damaged. Add `--replace-secret-key` to overwrite an existing secret key with the one in the backup.
4. Start the stack: `docker compose up -d --wait`. The server applies any migrations the backup lacks (after writing its own `main-pre-…` copy), and rebuilds the search index if the backup had none. Searching works while it rebuilds.
5. Check the result. Open Settings, Storage and run a verify. A clean report means every stored file is present with the right size. If it reports missing files, the volume copy was older than the database backup; restore a newer volume copy or let verify mark the affected pages as partial.

A backup made by an older version restores into a newer one. The reverse does not work: the server refuses a database from a newer version than it knows.

## Restoring on a different machine

Mount the storage volume at the same container path (for example `/volumes/default`), set the same `NCB_VOLUMES_ALLOWED_ROOTS`, and follow the steps above. Set `NCB_SECRET_KEY` to the old value, or restore `secret.key`, if you want stored provider keys to keep working. If a volume's path is different, its pages show as offline until you register the volume again at the new path; the restore tool warns you about each such volume.

## Tested

`tests/integration/storage/backup-restore.test.ts` backs up an archive, makes the backup look like an older version, restores it into a fresh data directory, migrates, starts, and checks that pages, search, sources and the archive's own verify all work. It also covers damaged backups, a running server, a non-empty target, and the command line tool. `tests/reliability/kill-restart.test.ts` kills the server in the middle of a backup and checks that no half-written backup is left.
