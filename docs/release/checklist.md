# Release checklist

Steps to release NoConBrain. The Human does the ones marked "Human" because they publish or cost something. Nothing in this repository tags, pushes images or creates a GitHub release by itself.

## Before the tag

1. All CI jobs are green on the commit to release: typecheck, unit, integration, storage safety, discovery, reliability, security, Chromium and Firefox end to end, licence audit, image builds on both architectures.
2. Run what CI does not, on a Linux host with Docker:
   - `scripts/offline-test.sh` (the no-egress check; HB-21) and the `frontend` network check (HB-02).
   - `docker compose up -d --wait` with the images built from this commit, on amd64 and arm64.
3. On a Raspberry Pi 5 and a Pi 4, if the release is to say it runs on them: follow [guides/install.md](../guides/install.md), run `pnpm bench:scale --pages 50000`, and fill the Pi rows in [benchmarks.md](../benchmarks.md). If no Pi is available, the release notes must say so.
4. Upgrade test: install the previous release with some data, take a backup, pull the new images, start, run Settings, Storage, Verify. A clean report passes. Keep the backup until the new version has run for a day.
5. A person has used the app with a screen reader and in Safari (see [accessibility.md](../accessibility.md) and [browser-support.md](../browser-support.md)), or the notes say not.
6. Run `pnpm traceability` and `pnpm docs:check`. Update [acceptance.md](../acceptance.md) so that every status is true for this build.
7. Set the version: `pnpm version:set 1.0.0` (or `1.0.0-rc.2`). Move the changelog entry from "not yet tagged" to a date. `scripts/test/version.test.ts` fails if the places disagree.
8. Review the open items in [hardening-backlog.md](../hardening-backlog.md). Anything open that a user could hit goes into the "Known gaps" part of the changelog.

## The tag (Human)

1. Review [release.yml.draft](release.yml.draft). Copy it to `.github/workflows/release.yml` and commit it.
2. In the repository settings, allow workflows to write packages.
3. Commit the version and changelog, then `git tag v1.0.0 && git push origin v1.0.0`.
4. Watch the workflow. It builds the three images for both architectures, attaches provenance and an SBOM, starts the published images on both architectures, and creates a draft release.

## After the tag (Human)

1. Open the draft release, read the notes, then publish it. A release candidate stays marked as a pre-release.
2. Make the three GHCR packages public (new packages start private). Check from a machine that is not signed in: `docker pull ghcr.io/slaterjohn/nocon-brain/server:1.0.0`.
3. Verify the attestation: `gh attestation verify oci://ghcr.io/slaterjohn/nocon-brain/server:1.0.0 --owner slaterjohn`.
4. Update the install guide's version number if it names one.

## Rolling back

Images for older versions stay in GHCR. To go back: stop the stack, restore the pre-upgrade backup (see [guides/backup-restore.md](../guides/backup-restore.md); a database written by a newer version is refused by an older one, so restoring is the only way back), set `NCB_VERSION` to the old version, and start. Say in the release notes if a version has a migration that cannot be undone by going back without a restore.
