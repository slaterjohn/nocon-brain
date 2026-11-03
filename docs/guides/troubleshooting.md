# Troubleshooting

Start with the logs and the checks, then find the symptom below.

```sh
docker compose ps                      # are server and web healthy?
docker compose logs --tail 100 server  # what the server says
docker compose logs --tail 50 web
```

In the app, **Storage and settings, Activity log** lists what the server did and why something failed, in plain words. **Check and repair** compares the database, the saved files and the search index and reports differences without changing anything unless you choose Repair.

## It does not start

| Symptom | Cause and fix |
|---|---|
| `Set NCB_PROXY_SECRET in .env` from Compose | The setting is empty. Run the `sed` line from [install.md](install.md), or set any value of at least 16 characters. |
| `Invalid configuration: NCB_...` in the server log | A setting has a value the server cannot read. The message names the setting and what it expects. Fix `.env` and run `docker compose up -d`. |
| `Another NoConBrain server (pid ...) already holds the database lock` | A second server uses the same data directory. Stop the other one. After a crash the lock file is replaced automatically when its process is gone, so this message means a live process. |
| `server` is "starting" for minutes on a large library | The server checks the search index end to end before it serves, which takes about 45 seconds at 500,000 pages (HB-27). The health check allows five minutes. Wait for `docker compose ps` to say healthy. |
| `server` is killed (exit 137) when storage runs short of space on a very large library | Planning what to remove loads every page: about 2.7 GB at 500,000 pages (HB-28). Raise `NCB_SERVER_MEMORY` (default `768m`) on a machine that has the memory. |
| `web` waits for `server` forever | `server` is not healthy. Read its log. A migration that failed stops the server; the message says which one. Restore the backup in `/data/backups` if needed ([upgrade.md](upgrade.md)). |
| A bind-mounted folder gives "permission denied" or a volume that cannot be used | The containers run as user 1000. `sudo chown -R 1000:1000 <folder>`. Docker creates a missing folder as root. |
| The setup wizard says the storage folder is not allowed | The folder is outside `NCB_VOLUMES_ALLOWED_ROOTS` (default `/volumes`). Mount it under that path or add its path to the setting. |
| `pnpm install` fails on `@openzim/libzim` | It compiles a small wrapper and needs `python3`, `make` and a C++ compiler. Docker images are not affected. See [development.md](development.md). |
| `kernel.apparmor_restrict_unprivileged_userns` or Chromium will not start in the renderer | The host forbids unprivileged user namespaces. The renderer cannot run there; leave it off. Plain capture still works. |

## The app opens but something is wrong

| Symptom | Cause and fix |
|---|---|
| "This request came from a different website than the app" | `NCB_APP_URL` is not the address in your browser bar. Set it to exactly that (scheme, host and port) and restart. |
| Signing in works but you are signed out at once | The browser rejected the cookie. If you serve over HTTPS, set `NCB_COOKIE_SECURE=true`. If you serve over plain HTTP, leave it `false`. |
| Saved pages show a blank frame or "refused to connect" | The browser cannot reach the archive port. Open `http://<host>:3002/healthz` from the same machine. Publish the port, open it in the firewall, or set `NCB_ARCHIVE_PUBLIC_URL` if a proxy serves it on another address. |
| Search results never appear, then all arrive together | A reverse proxy is buffering the event stream. Turn buffering off for the app ([install.md](install.md#behind-a-reverse-proxy-with-https)). |
| Search says the index is being rebuilt | The index is missing, damaged or from an older layout. It rebuilds from your saved pages on its own; progress is under Storage and settings. Pages saved meanwhile are added afterwards. |
| Search misses a page you know is saved | Run Check and repair. If it reports index differences, choose Repair. For a large mismatch it offers a full rebuild. |
| A page opens with missing images or styles | The copy is marked partial: some files could not be fetched or are missing. Open the page's details to see which. Saving the page again may fix it. |
| A link in a saved page says it is not saved | The page it points to was not part of the download. This is expected; the legend explains the link colours. Use Save to add it. |

## Downloads

| Symptom | Cause and fix |
|---|---|
| Downloads are paused with a disk message | Free space is below `NCB_MIN_FREE_DISK_GB`, or the volume is over its quota. Free space, add a volume, or lower the setting. Downloads resume on their own. |
| A download waits and shows a reason | The Downloads view names it: a download window is closed, a per-host delay applies, the machine is busy, or you are offline. |
| A site is refused | The address points at a private or local network, or robots.txt disallows it. NoConBrain will not fetch private addresses unless an operator allows it, and obeys robots.txt. |
| Wikipedia saving does nothing | Wikipedia features need `NCB_CONTACT` (an email or a web address) so that requests can identify you. Set it and restart. |
| A page captured with no content | It may build its content with scripts. Turn on the renderer ([install.md](install.md#optional-services)). |

## Storage and space

| Symptom | Cause and fix |
|---|---|
| The disk is nearly full | Open Storage and settings, Space, then Removal preview. It shows what would be removed first and why. P1 (Protected) content is never removed automatically. Raise a source's priority to protect it. |
| A volume shows as offline | Its drive is missing or its marker file is gone. Reconnect it; it comes back by itself. Pages on it show as offline meanwhile. |
| Check and repair reports "a stored file is missing" | The file was deleted outside the app, or a restore used an older volume copy. Repair marks the affected pages partial and keeps the rest. Restore the files from your volume backup to bring them back. |
| Check and repair reports files with no database row | Leftovers from an interrupted save. Repair moves them into the volume's `quarantine` folder; it never deletes them. |

## Backups

| Symptom | Cause and fix |
|---|---|
| Restore refuses with "a server is running" | Stop `server` first: `docker compose stop server web`. |
| Restore refuses with "already has a database" | Add `--force`. The old database is kept as `main.db.before-restore-<time>`. |
| After a restore, pages show as offline | The storage volumes are at different paths from the ones in the backup. Mount them at the old paths, or register the volume again ([backup-restore.md](backup-restore.md#restoring-on-a-different-machine)). |

## Still stuck

Collect the last 100 lines of `docker compose logs server`, the Activity log entry for the failure, the version (shown in the footer of every page), and what you were doing. Open an issue at <https://github.com/slaterjohn/nocon-brain/issues>. Remove any address or name you want to keep private first. Report security problems privately, as [SECURITY.md](../../SECURITY.md) explains.
