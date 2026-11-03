# Upgrade

Upgrading means replacing the images (or the source) and starting again. The server migrates its database on start, so the data volumes stay where they are.

## Before you upgrade

1. Read [CHANGELOG.md](../../CHANGELOG.md) for the versions between yours and the new one. Anything that needs a manual step is listed there.
2. Take a backup and copy it off the machine. A migration cannot be undone by installing the old version again, because an older server refuses a database written by a newer one. The way back is a restore. Follow [backup-restore.md](backup-restore.md), including the copy of the storage volumes.
3. Check there is free space for a copy of `main.db` (see the size under Storage and settings, Space). The server writes one before each migration.

## Upgrade

From a clone of the repository, building locally:

```sh
git fetch --tags
git checkout v1.0.0        # the version you want
docker compose up -d --build --wait
```

With published images:

```sh
# in .env: NCB_REGISTRY=ghcr.io/slaterjohn/  and  NCB_VERSION=1.0.0
docker compose pull
docker compose up -d --wait
```

Compose recreates `server` and `web`. In-progress downloads are put back in the queue when the server stops, and running stages continue from their last checkpoint when it starts.

## What happens on start

- If migrations are pending, the server copies `main.db` to `/data/backups/main-pre-<migration>-<time>.db` first (the newest five are kept), then applies them in order. A migration that fails is rolled back completely and the server stops with a message in its log. Old copies are pruned automatically.
- If the search index was built by an older layout, it is rebuilt from the saved content in the background. Search says the index is being rebuilt until it is ready, and results appear when it is. How long a rebuild takes is in [benchmarks.md](../benchmarks.md#scale-test-500000-pages).
- The server refuses to start on a database from a newer version than it knows. Restore a backup made by the version you are running, or upgrade.

## After you upgrade

1. `docker compose ps` shows both services healthy.
2. In the app, open Storage and settings, Check and repair, and run a check. Compare with a check taken before the upgrade if you have one.
3. Keep the backup for a few days.

## Going back

1. `docker compose down`.
2. Restore the backup you took (see [backup-restore.md](backup-restore.md)), using `--force`, which keeps the newer database as `main.db.before-restore-<time>`.
3. Set the old version (`git checkout <old tag>` or `NCB_VERSION=<old>`) and `docker compose up -d --wait`.

## Tested

`tests/integration/storage/backup-restore.test.ts` takes a backup, makes it look like it came from the previous migration, restores it, migrates it and checks pages, search and verify. `tests/integration/db/database.test.ts` and `tests/integration/db/sources-migration.test.ts` cover the pre-migration copy, rollback of a failing migration, refusal of a newer database, and a migration that rebuilds tables with data in them. An upgrade from the last published release has not been tested, because no earlier release exists.
