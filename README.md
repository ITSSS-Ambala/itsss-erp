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

## Build and upload

```sh
npm run install:ci
npm run build
npm run package:hostinger
```

Upload **`outputs/hostinger-crm-upload.zip`** through Hostinger's **Node.js Web
App** flow. Its root includes `package.json`, a matching lockfile and application
sources. Hostinger builds it on Linux; no Windows dependency binaries are packed.

Build settings: **Next.js, Node.js 24, `npm run build`, output `.next`, start
`npm start`**. Hostinger injects `PORT`; the server listens on `0.0.0.0`.
The build produces `.next/standalone/server.js` with its public and static assets.
If deploying from GitHub, publish all updated source files to the repository and
branch selected in Hostinger; generating a local ZIP does not update GitHub.
An old deployment that logs `scripts/run-framework.mjs` is still building Vinext.

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
Additional logins need both a credential in `ERP_AUTH_USERS` and an active user
record/role in the workspace. Technician and Client mappings are enforced by the
existing access policies. Public identity headers and old mock cookies are ignored.

Sessions use opaque random tokens, server-side expiry and revocation, and secure
HttpOnly cookies in production. Passwords use salted scrypt hashes. Login
attempt limits and same-origin mutation checks apply. UI password resets and
two-factor authentication remain unavailable.

Business records and sessions persist in `workspace.sqlite`; files persist under
the private `files/` directory. Revision checks prevent stale writes. Vault
records remain AES-256-GCM encrypted in storage and JSON backups.

A fresh workspace seeds demo records. Deployment does not copy the old local
database, uploads or business records. Back up SQLite consistently, the file
directory and the vault key. Manual JSON backups contain file references, not
uploaded bytes. This runtime targets one server/persistent disk, not replicas
with independent local storage.

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
