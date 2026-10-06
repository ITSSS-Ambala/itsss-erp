# ITSSS Internal ERP

A responsive internal ERP inspired by the supplied ITSSS dashboard design, with INR calculations, a navy sidebar, live dashboard charts, light/dark themes and mobile navigation.

The implementation includes **70 module schemas and 250 demo records** covering CRM, customer sites, projects, technicians, stock, purchases, finance, support, renewals, staff, marketing, documents and administration. Quotations and invoices are intentionally excluded, as requested in the feature-list attachment.

See [the 85-section feature audit](docs/FEATURE_AUDIT.md) for precise coverage, executed checks and unfinished integrations. This project does not claim that every production requirement is complete.

## Repository

Source is maintained in the private [jabbersinghdhami/itsss-erp](https://github.com/jabbersinghdhami/itsss-erp) repository on `main`. Environment secrets, local business data, uploaded files, dependencies and generated build/test output are excluded from Git. A fresh clone needs the runtime bindings and local setup described below.

## What works

- Validated record forms, linked detail/activity views, search, status/city filters, saved views, CSV/XLSX import/export, record PDFs, file attachments and QR asset lookup.
- Lead Won conversion creates a linked customer/site/project once. Project completion creates a follow-up. Ticket creation assigns the site technician. Renewal and due rules produce idempotent in-app records.
- Purchase receipts, transfers and project material reservations/consumption/returns update stock without negative quantities or repeated posting.
- Received payments, refunds, approved expenses and historical material costs recalculate project balances/profit. Values round to INR paise; receipt overpayments reject.
- Custom fields, safe arithmetic formula fields, custom modules/statuses, record-form presets, category dictionaries, role allowlists and field masks.
- Server-enforced workspace membership, customer-owned Client data, explicit Technician assignments, protected uploads/downloads and immutable mutation history.
- Soft delete, recycle bin, archive/restore and reference-protected permanent deletion. Archiving retains economic balances.
- AES-256-GCM vault encryption at rest and in manual JSON backups. Validated restore preserves current users/roles/audit history.

Dashboard customization and theme preference are stored in the current browser. Business records persist in Cloudflare D1; uploaded file bytes persist in R2.

## Run locally

Node **24.13.0** was used for verification. Application dependencies require Node 22.13 or newer; use Node 24 for the native TypeScript test commands below.

1. Install dependencies with `npm run install:ci`.
2. Configure a private `ERP_VAULT_KEY` runtime binding: base64 encoding of 32 random bytes. For local Wrangler/Vite preview, place it in the ignored `.dev.vars` file. Keep the key out of source control and retain it securely; encrypted data and backups require the same key.
3. Build with `npm run build`.
4. Apply the local D1 schema once, using the generated Worker configuration:

   ```sh
   node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_futuristic_darkhawk.sql
   ```

5. Run `npm run dev` and open the loopback URL printed by the server, normally `http://127.0.0.1:5173`.
6. In the portable development profile, visit `/signin-with-chatgpt?return_to=/` for the local mock identity. This mock is restricted to loopback development and is excluded from production builds.

The empty workspace initializes on the first authenticated request, with that identity as Super Admin and seeded demo business data. The demo label is visible by default. Hiding the label does not remove the sample records.

`npm start` previews the built Worker using project-local `.wrangler/state`. It does not simulate production sign-in. Local state, environment files and build outputs are ignored by Git.

## Access and storage

Hosted authentication uses the existing ChatGPT sign-in integration. Identity alone is insufficient: the server also requires an active ERP user record and active role. Administrators add team members by verified email and assign their role. Map a Technician user to an active employee and a Client user to their customer; unmapped accounts fail closed for business data.

Set hosting access policy before opening a new production workspace, because its first authenticated visitor becomes owner. Hosted requests supply identity headers; do not implement a public mechanism for clients to inject them.

- `DB`: D1 binding, containing `erp_workspace` and its revision-controlled JSON snapshot.
- `BUCKET`: R2 binding, containing private uploaded files.
- `ERP_VAULT_KEY`: private base64-encoded 256-bit key.

The server rejects stale revisions instead of overwriting another user's update. Refresh and retry after a conflict. Uploads are limited to 20 MB per file; imports to 500 rows per request. Backups are limited to 15 MB when restored.

## Verification

```sh
npx tsc --noEmit
node --experimental-strip-types --test tests/engine.test.ts tests/permissions.test.ts tests/vault.test.ts
npm run build
```

The automated suite currently passes **58 tests**: 36 business-engine, 13 access/restore and 9 vault tests. It covers calculations, stock invariants, idempotency, role scopes, hidden fields, file access, approval transitions/reversal, safe formulas, deletion/restore and encryption/tamper rejection.

Final TypeScript and production build checks passed after the Excel default-import interoperability adjustment. Local browser checks covered desktop 1440x1000, mobile 390x844 and tablet 768x1024 without horizontal page overflow on mobile/tablet. A mobile Won lead persisted after refresh with its linked customer/project and passed delete/recycle/restore. Dark/Light switching, calendar Next/Today, real PDF/XLSX downloads, QR rendering and manual asset lookup also passed.

The app's Excel reader and authenticated local import API processed an XLSX row. R2 upload/linked-download returned exactly matching file bytes, and backup export contained encrypted vault envelopes. The browser import picker was blocked by the browser extension's disabled file-URL access; its mapping/preview flow remains unverified. Detailed evidence is tracked in [FEATURE_AUDIT.md](docs/FEATURE_AUDIT.md).

Hosted publication has not been completed or verified. These checks do not prove real camera behavior, delivered messages or every UI workflow.

## Integration boundaries

Email and WhatsApp buttons open external compose applications. App-side sending, delivery history, push notifications and inbound email synchronization need providers and credentials. Due/renewal rules run during authenticated workspace requests; an unattended scheduler is not configured.

Manual JSON backup contains database records and R2 file references, with encrypted vault records. It does not contain uploaded file bytes. Restore requires the corresponding R2 objects and vault key. Daily/scheduled/offsite backups and archived restore-point blobs need separate operational configuration.

User `twoFactor`/`lastLogin` and company `passwordMinLength`/`sessionMinutes` fields are metadata. This app does not enforce its own password hashing, 2FA, password policies or session timeout. Authentication/HTTPS policies belong to the hosting identity layer; login/logout/download/vault-read audit events still need implementation.

Advanced approval thresholds, automatic document version chains, all specialized filters, complete form-response workflows and bespoke saved document-template layouts remain partial. Camera scanning uses browser `BarcodeDetector` where available, with manual serial/SKU lookup otherwise; real-device camera/GPS/signature behavior still needs acceptance testing. The browser import/mapping flow and every requested PDF layout also require document QA.

## Main implementation files

- [Schema and dynamic configuration](lib/schema.ts), [seed data](lib/seed.ts), [business engine](lib/engine.ts).
- [Access policies and restore validation](lib/access.ts), [D1 workspace persistence](lib/server.ts), [encrypted vault](lib/vault.ts).
- [Workspace API](app/api/workspace/route.ts), [file API](app/api/files/route.ts), [backup API](app/api/backup/route.ts).
- [Application and forms](app/erp-app.tsx), [dashboard](app/dashboard.tsx), [reports](app/reports.tsx), [asset tools](app/asset-tools.tsx), [spreadsheet/PDF/QR utilities](lib/file-utils.ts).
- [Feature acceptance audit](docs/FEATURE_AUDIT.md), [engine tests](tests/engine.test.ts), [permission tests](tests/permissions.test.ts), [vault tests](tests/vault.test.ts).

The application runs on React/Vinext with a Cloudflare Worker, D1 and R2. The included Sites execution-profile and build scripts support portable development and managed deployment. Publish through the configured hosting workflow; a local build or preview does not deploy the site.

## Final verification

Final production build and TypeScript check passed after the last implementation changes. The final automated suite passed all 58 tests. Local browser and API checks are described above. The private GitHub repository contains the application source; the hosted app has not been deployed.
