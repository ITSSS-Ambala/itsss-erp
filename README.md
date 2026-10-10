# ITSSS Business Hub

Internal ERP with CRM, customer sites, projects, technicians, stock, purchases,
finance, support, renewals, staff, marketing, documents and administration.
The existing business engine, role scopes, INR calculations, project timelines,
private media, custom fields and encrypted vault are retained.

The app now runs on **Next.js with Node.js 24**, using **SQLite and private disk
storage**. Email/password sessions replace the previous hosted identity layer.
Cloudflare Worker, D1 and R2 bindings are no longer required by the app.

The requested production address is **https://crm.itsss.co.in**. See
[the Hostinger deployment guide](docs/HOSTINGER_DEPLOYMENT.md) for the exact
upload flow, runtime settings, persistent data directory and first login.

## Build and deploy from GitHub

```sh
npm run install:ci
npm run build
```

Push updated application sources to **`ITSSS-Ambala/itsss-erp`**, branch **`main`**,
which is connected to Hostinger. A ZIP upload is unnecessary for this deployment.

Build settings: **Next.js, Node.js 24, `npm run build`, output `.next`, start
`npm start`**. Hostinger injects `PORT`; the server listens on `0.0.0.0`.
The build produces `.next/standalone/server.js` with its public and static assets.
If deploying from GitHub, publish all updated source files to the repository and
branch selected in Hostinger; generating a local ZIP does not update GitHub.
An old deployment that logs `scripts/run-framework.mjs` is still building Vinext.

## Leads, list actions and project files

**Leads** is the company directory. Enter the company name, contact person,
phone, email, website and addresses in one profile. Existing customer records
appear here automatically; their billing IDs, project links and client access
remain intact. Projects and payment forms use **Lead / company** selectors.

Select list rows to reveal **Actions**: delete to the recycle bin, archive,
change status, assign an employee or export, according to your role. The header
checkbox selects the current page; **Select all matching** includes other pages
(up to 500 records). Bulk changes save together or fail without partial changes.

Files uploaded during project creation appear under **Project files** in the
Progress view and **Attachments** tab. Image previews and downloads retain the
project's access restrictions. Use **Edit record** to add or remove attachments.

Administrators can edit the announcement with the top bar pencil or through
**Settings → Edit announcement**. They can change the text, stop its animation,
hide it temporarily or remove it. Settings can restore a removed announcement.

This app needs a Node.js-capable hosting plan. Extracting files into a PHP/static
`public_html` directory cannot run its server APIs. The older
`itsss-production-build.zip` is a historical Cloudflare artifact, not the
Hostinger package.

## Configuration

Use `.env.example` as a reference and set the real values privately in Hostinger:

- `ERP_PUBLIC_URL=https://crm.itsss.co.in`.
- `ERP_DATA_DIR`: an absolute, private, writable persistent directory outside
  `public_html`, `hbuilds` and the app deployment directory.
- `ERP_ADMIN_EMAIL`, `ERP_ADMIN_PASSWORD_HASH`, `ERP_VAULT_KEY`.
- Optional `ERP_ADMIN_NAME`, `ERP_SESSION_HOURS` and `ERP_AUTH_USERS`.

Generate a password hash with `npm run auth:hash`; the terminal input is hidden.
Generate a **new-workspace** vault key with `npm run vault:key`. Retain the
original key when migrating encrypted data. No default passwords or real secrets
are included in the upload ZIP.

For local development, copy `.env.example` to ignored `.env.local`, use a
loopback `ERP_PUBLIC_URL` matching the dev server, and a private absolute local
data directory. Then run `npm run dev`. `npm start` previews the production
Next.js build with the same private configuration.

## Access and persistence

The configured administrator initializes a new workspace as Super Admin.
Create additional users in **Settings → Users**, assign an active role, then use
**Set password**. The password dialog also opens after creating a user. Existing
`ERP_AUTH_USERS` credentials continue to work for active workspace members.
Technician and Client mappings are enforced by the existing access policies. Public identity headers and old mock cookies are ignored.

Sessions use opaque random tokens, server-side expiry and revocation, and secure
HttpOnly cookies in production. Passwords use salted scrypt hashes. Login
attempt limits and same-origin mutation checks apply. Administrators can set or
reset passwords from a user’s details or edit form. Every user can choose
**Change password** from the navigation or profile menu and verify their current
password. Passwords require at least 12 characters (or the higher company policy)
and at most 256 bytes. Saving a password revokes that user’s existing sessions.
Two-factor authentication remains unavailable.

Business records, password hashes and sessions persist in `workspace.sqlite`;
files persist under the private `files/` directory. Revision checks prevent stale writes. Vault
records remain AES-256-GCM encrypted in storage and JSON backups.

A fresh workspace seeds demo records. Deployment does not copy the old local
database, uploads or business records. Back up SQLite consistently, the file
directory and the vault key. Manual JSON backups contain file references, not
uploaded bytes or login password hashes. Retain the SQLite database to retain
managed login passwords; restoring a JSON backup leaves current passwords intact.
Rotating a configured environment password hash overrides its managed password
for account recovery. This runtime targets one server/persistent disk, not replicas
with independent local storage.

## Notifications

The bell and Notifications module use the same personal, server-generated inbox.
Alerts use complete business records before applying the recipient's record and
field permissions. Paid balances, completed work, invalid dates, archived sources
and demo records do not create active reminders. Legacy sample notifications are
excluded. Due dates use Asia/Kolkata; timed follow-ups wait until their due time.

Assignment and record events are saved when a change succeeds. Active assigned
staff, project/site teams, authorized supervisors and the relevant department
receive updates within their access. Clients receive permitted updates for their
own customer records. The actor does not receive their own event notification.
Technician users need an Employee mapping and client users a Customer mapping.

Open sessions refresh the inbox every 15 seconds and on focus or opening the bell.
Unread counts include the entire inbox. Individual and bulk read status persists
per user in SQLite across devices and server restarts; reading never changes a
business record. Resolved reminders leave the active inbox and recurring issues
get a new unread alert. Saved events remain available when a user next signs in.
Due reminders are evaluated during authenticated requests; email, WhatsApp, push
and unattended scheduling require separate integrations.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run verify:hostinger
npm run verify:hostinger -- --standalone
```

Tests cover the existing business/access/vault/media behavior plus the Node.js
database, password/session and storage adapters. Production verification checks
login, API permissions, file bytes/ranges, encrypted backup, revision conflicts,
restart persistence and logout using isolated synthetic data.

The [feature audit](docs/FEATURE_AUDIT.md) records the prior implementation's
coverage and limitations. Its Cloudflare setup references are historical; use
the current Hostinger guide for deployment. Email/WhatsApp sending, unattended
scheduling, scheduled/offsite backups, UI 2FA, advanced approval thresholds and
some specialized workflows remain integration/acceptance work. Real-device media
and every role/device workflow have not been fully verified.

No live Hostinger deployment is implied by a local build or generated ZIP.
