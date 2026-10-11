# Full app backup and recovery

Administrators can open **Settings → Full backup & restore** or **Backups**.
Enter and confirm a password of at least 12 characters, then choose **Create full
backup**. The app saves a `.itsss-backup` file under the private
`ERP_DATA_DIR/backups` directory. Download it to another device or drive and keep
its password separately. A backup on the same disk cannot survive loss of that disk.

The archive contains:

- A consistent SQLite snapshot, including business records, users, roles,
  managed password hashes, notification read/clear state and audit history.
- Actual uploaded file bytes and their permission metadata, including company
  logos and project attachments.
- Private recovery configuration, including the original vault key and
  configured administrator credentials.
- Application source when run from a source checkout; otherwise the available
  standalone deployment files and dependencies. A runtime snapshot needs the
  same operating system/architecture and Node.js 24. A source snapshot can be
  rebuilt on another compatible system.

The entire compressed archive uses password based scrypt key derivation and
AES-256-GCM authenticated encryption. File checksums and SQLite integrity are
checked during recovery. Neither the password nor an unencrypted archive is
saved beside the backup. Losing the backup password makes that archive unusable.
Archives are limited to 2 GB compressed and 4 GB expanded. Backups are manual;
no unattended schedule or offsite synchronization is configured.

## Restore while the app works

Choose **Restore from file**, select a `.itsss-backup` archive, enter its password
and type `RESTORE`. This replaces the complete database and upload directory,
including users and their managed passwords. The archive must contain an active
administrator matching the server's configured administrator email.

The app validates and stages the archive before touching live data, creates a
password protected safety backup using the same password, checks for concurrent
workspace changes and active uploads, and installs the recovered data. An
interrupted installation rolls back from a disk journal on the next startup.
Existing sessions are revoked; sign in again using the restored accounts.
Current server environment settings and running application files stay in place.
Vault records are reencrypted with the server's current key during this restore.

If data changes while recovery is preparing, refresh the workspace and retry.
The safety backup appears in the saved backup list and remains downloadable.
Keep deployment-level request/upload limits and timeouts large enough for the
archive size; larger archives can always be restored with the offline command.

The **Records only (legacy JSON)** option remains available for older backups.
It does not contain uploaded bytes, managed passwords or application files and
preserves current membership during restore. Use a full archive for disaster recovery.

## Restore after a crash, damaged database or lost deployment

1. Stop the Node.js application before offline restore. Keep the downloaded
   archive and its password available. Recover from a clean checkout/source
   upload package, or the `recovery-tool` folder included in a standalone build.
2. Run the recovery command with Node.js 24. It prompts for the password with
   hidden input; do not put passwords in command arguments:

   ```sh
   node --experimental-strip-types scripts/recovery.mjs restore --file /private/ITSSS.itsss-backup --data-dir /private/itsss-data --confirm RESTORE --app-dir /private/recovered-app
   ```

   From an existing standalone deployment, use
   `recovery-tool/scripts/recovery.mjs` instead. `--app-dir` is optional when
   recovering only data; when supplied it must be a new directory separate from
   the data directory. The command does not need a working database, app server
   or configured vault key. Previous data is retained in a private recovery
   staging folder if no consistent safety archive can be made.
3. Set the private environment values from
   `ERP_DATA_DIR/recovery-config.json` in Hostinger, or load them in your service
   configuration. This file contains secrets: keep it outside publicly served
   and deployment directories. The restored vault requires the original key
   from this file. Use your actual persistent data path and application URL.
4. For a source snapshot, use Node.js 24 and run `npm ci`, `npm run build` and
   `npm start` from the recovered application directory. For a runtime snapshot,
   launch its `server.js` with Node.js 24 on the same platform, with the private
   environment configuration and assigned `PORT`.
5. Sign in, check company records and an uploaded attachment, then create and
   download a new full backup.

To create a backup from a working server's command line, use `npm run backup`
with the same private environment as the app. For local configuration:

```sh
node --env-file=.env.local --experimental-strip-types scripts/recovery.mjs backup
```

The CLI also accepts `--config /private/recovery-config.json` for a restored
server. Noninteractive commands read the password from standard input, allowing
a scheduler to supply it through a private secret mechanism without embedding
it in process arguments. Keep copies of both the upload package and recovery
command off the server so recovery remains possible after total server loss.

In a standalone deployment, the backup command is
`node --experimental-strip-types recovery-tool/scripts/recovery.mjs backup`.
