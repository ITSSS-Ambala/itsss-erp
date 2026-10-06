# ITSSS Internal ERP

A responsive internal ERP inspired by the supplied ITSSS dashboard design, with INR calculations, a navy sidebar, live dashboard charts, light/dark themes and mobile navigation.

The implementation includes **72 module schemas and 250 demo records** covering CRM, customer sites, projects, technicians, stock, purchases, finance, support, renewals, staff, marketing, documents and administration. Quotations and invoices are intentionally excluded, as requested in the feature-list attachment.

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

## Inline dropdown creation

Business dropdowns are searchable. Authorized users can create related records in nested forms, select the new record automatically, and keep unfinished parent drafts. Multiselect fields append new records without removing prior selections. Roles use the complete role definition form; new record-form templates start with the current module and Published status.

Shared cities, brands, departments, stock locations, categories, lead sources and payment methods persist across matching fields. Other eligible business choices, including custom radio and multiselect fields, persist per field. Creation follows server permissions and hidden-field rules; normalized duplicates reuse the existing value. Filters, chart ranges, themes, implementation/security controls and enums that determine financial posting remain fixed.

## Project timelines and company logos

Project details include progress updates, comments, replies and photo/video/audio attachments. Authorized project members can contribute; mapped installers see assigned projects, including projects linked to their assigned sites, and can update progress/stage without editing financial or assignment fields. Mapped Clients can comment on their own projects; Viewer remains read-only. Authors can edit/delete their entries, and administrators can moderate, pin and delete entries. Moderation preserves historical progress rather than replaying or reversing it.

Each post accepts up to **10 attachments**, with **20 MB per image/audio file** or **100 MB per video**. The server validates supported media signatures and project scope; authenticated previews and single-range video/audio responses use private caching rules. Anonymous access is not supported. Real-device camera capture and playback across every browser/codec remain acceptance work.

Administrators can upload, replace or remove the company logo in settings, preview it, then save the company profile to apply it. Logos accept **PNG, JPEG, WebP or GIF up to 5 MB**. Only the currently linked logo is shared with authenticated workspace members; unsaved/replaced files are not public branding. Local Super Admin browser checks verified saved comments, replies, progress updates, logo display and removal; upload/save was verified through the local API. The browser file picker, other-role UI and real-device media remain unverified.

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

The server rejects stale revisions instead of overwriting another user's update. Refresh and retry after a conflict. Ordinary attachments and timeline images/audio are limited to 20 MB per file; timeline videos to 100 MB, with 10 attachments per post; company logos to 5 MB. Imports allow 500 rows per request. Backups are limited to 15 MB when restored.

## Verification

```sh
npx tsc --noEmit
node --experimental-strip-types --test tests/engine.test.ts tests/permissions.test.ts tests/vault.test.ts tests/dropdowns.test.ts tests/media.test.ts tests/project-posts.test.ts
npm run build
```

On **7 October 2026 (Asia/Kolkata)**, Node **24.13.0** passed TypeScript, the production build and **115/115 tests** across all six test files, with no failures or skips. They cover calculations, stock invariants, idempotency, role scopes, hidden fields, file access, approval transitions/reversal, safe formulas, deletion/restore, encryption/tamper rejection, dropdown persistence and project-post/progress authorization. Media checks cover format/size validation, byte ranges and safe response headers.

Local Super Admin browser checks on the same date created a synthetic project, saved a comment, nested reply and update, and confirmed all three entries plus **30% / Installation In Progress** after reload. Editing and saving the update's message preserved its recorded progress. Logo API upload/save and byte-identical private inline download passed; anonymous download returned **401**. The browser displayed the saved logo in the sidebar and preview, and Remove logo followed by Save cleared it; the original logo was restored afterward. The synthetic project and its three posts were soft deleted; original records and logo were preserved. A hidden-media UI issue was fixed and checked with an access regression test and React server rendering. Other roles were checked through code/tests, without live other-role browser sessions. The Chrome extension's disabled file-URL access blocked the browser upload picker.

Earlier local browser checks covered desktop 1440x1000, mobile 390x844 and tablet 768x1024 without horizontal page overflow on mobile/tablet. A mobile Won lead persisted after refresh with its linked customer/project and passed delete/recycle/restore. Dark/Light switching, calendar Next/Today, real PDF/XLSX downloads, QR rendering and manual asset lookup also passed.

Desktop checks for this revision verified draft retention on cancel, automatic customer selection, nested Site/category creation, inherited customer links, technician multiselect append, saved relationships after a fresh API read, normalized duplicate reuse without a revision change, stale-revision rejection, fixed payment-status rejection and deep-link edit retention. Escape closes the open choice list, Ctrl/Cmd+K respects active dialogs, and failed option creation returns focus to the input while cancel preserves the old value. Template creation prefilled the current module and Published status, then saved and selected the template while retaining the parent draft; the form showed mapped fields plus required fields.

At mobile 390x844, the page and dropdown stayed within the viewport. Nested Customer/category creation selected both new values while retaining the Project draft, and parent Cancel worked. Thirteen synthetic records created for this revision were moved to Recycle Bin with immutable history retained; real user data was untouched. These checks cover the stated workflows, not every module/device combination.

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
- [Application and forms](app/erp-app.tsx), [project timeline](app/project-timeline.tsx), [project post/progress mutations](lib/project-posts.ts), [media validation/ranges](lib/media.ts), [logo control](app/company-logo-control.tsx), [searchable dropdowns](app/creatable-select.tsx), [inline choice dialog](app/inline-item-dialog.tsx), [dropdown persistence](lib/dropdowns.ts), [dashboard](app/dashboard.tsx), [reports](app/reports.tsx), [asset tools](app/asset-tools.tsx), [spreadsheet/PDF/QR utilities](lib/file-utils.ts).
- [Feature acceptance audit](docs/FEATURE_AUDIT.md), [engine tests](tests/engine.test.ts), [permission tests](tests/permissions.test.ts), [vault tests](tests/vault.test.ts), [dropdown tests](tests/dropdowns.test.ts), [media tests](tests/media.test.ts), [project-post tests](tests/project-posts.test.ts).

The application runs on React/Vinext with a Cloudflare Worker, D1 and R2. The included Sites execution-profile and build scripts support portable development and managed deployment. Publish through the configured hosting workflow; a local build or preview does not deploy the site.

## Final verification

The timeline/logo revision passed TypeScript, production build and **115/115 tests** on **7 October 2026 (Asia/Kolkata)**, with the local Super Admin browser/API checks described above. Browser file-picker upload, other-role UI and real-device media remain unverified. The private GitHub repository contains the application source; the hosted app has not been deployed.
