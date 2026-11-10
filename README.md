# Filebox

A fully working private file-management application built with Next.js App Router, React, TypeScript, Tailwind CSS, Lucide, PostgreSQL, and Drizzle ORM. The interface uses cardinal red `#C8102E`, gold `#D4AF37`, charcoal, white, and neutral grays, with responsive navigation and a saved dark theme.

## Quick start — no cloud credentials needed

Requirements: Node.js 22+, npm, and PostgreSQL 15+.

1. Install dependencies: `npm install`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`.
3. Apply the schema: `npx drizzle-kit push`.
4. Run locally: `npm run dev`, then open http://localhost:3000.
5. For production: `npx next typegen`, `npm exec tsc -- --noEmit`, `npm run build`, then `npm run start`.

The platform preview bootstraps PostgreSQL automatically. The committed `.env.example` contains no credentials for an external service.

### Honest, functional local mode

This deployment has PostgreSQL configured and does not require Supabase to work. In local mode, file bytes are written to a private server directory, never to PostgreSQL or `public/`. Local authentication uses scrypt password hashes and random, hashed HttpOnly sessions. The UI explicitly identifies local storage in the sidebar and Settings.

A first visit creates an isolated guest account and twelve **real** sample files. Each browser receives its own account and session; no global demo account is shared. Counts and usage are calculated from persisted rows and actual file byte lengths, not invented account statistics. Sample files can be previewed, downloaded, copied, moved, renamed, shared, and deleted. Creating a local account upgrades the current guest account and preserves its files. Signing into an existing account switches to that account's separate workspace. A guest session lasts seven days; register to retain login access to the workspace.

Local registration displays a cryptographically random recovery code **once**. Save it in a password manager. Local password recovery requires both email and this recovery code, rotates the code, and invalidates existing sessions. The app does not pretend to send email without a mail service. Supabase mode uses real confirmation and password-reset emails instead.

## Supabase setup

1. Create a Supabase project.
2. Set `DATABASE_URL` to its PostgreSQL direct connection or session-pooler connection string. The long-lived Node.js runtime uses `pg`; prefer session pooling over transaction pooling for the current implementation. URL-encode special characters in the password and use the TLS parameters required by your provider.
3. Set the **server-only** variables `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET=filebox`.
4. Apply `supabase/migrations/0000_filebox.sql` and then `supabase/migrations/0001_security_and_storage.sql` in the Supabase SQL editor, or initialize/link the Supabase CLI project and run `supabase db push`.
5. In Supabase Authentication → URL Configuration, set Site URL to your public `APP_URL` and allow the same origin as an email redirect URL. Enable email/password authentication and configure SMTP for reliable delivery.
6. Restart the application. Settings displays the active storage and authentication adapters.

The SQL creates a **private** `filebox` bucket. For a different bucket name, update both `SUPABASE_STORAGE_BUCKET` and the bucket IDs in the SQL policies. Never make this bucket public. Service-role credentials are used only by server modules and never enter the browser bundle. The browser receives only an object-scoped signed upload token, not a private key. Keep the privileged PostgreSQL connection server-side as well.

Cloud registrations requiring email confirmation show a real confirmation state. After confirming, sign in from the profile menu. Supabase recovery links open a new-password dialog. Local accounts created before a Supabase switch continue to sign in with local credentials; cloud accounts use Supabase identity UUIDs. Migrating existing local accounts/files into Supabase identities is an administrative migration, not an implicit account merge.

Cloud mode is implemented against the Supabase SDK but cannot be end-to-end verified without your project credentials. A bucket setup error is shown as an actionable error, never as a fake upload success.

## Architecture

- `src/components/dashboard.tsx`: workspace shell, navigation, debounced search, grid/list views, selection, context menus, breadcrumbs, and keyboard shortcuts.
- `src/components/ui.tsx`: brand, accessible focus-trapped modal, file representations, toast, and loading indicator.
- `src/components/dialogs.tsx`: file operations, previews, sharing, account forms, settings, storage, help, and activity.
- `src/components/upload-modal.tsx`: real progress, cancellation, retry, and resumable uploads.
- `src/components/shared-workspace.tsx`: independent public sharing experience, password entry, folder browsing, previews, and editor renames.
- `src/components/pdf-preview.tsx`: browser-independent PDF.js canvas rendering with page controls, zoom, loading states, and self-hosted worker/font/encoding assets in `public/pdfjs/`. If upgrading PDF.js, run `node scripts/copy-pdf-assets.mjs` to keep the worker version matched.
- `src/app/api/*`: validated authenticated REST endpoints. Client components never connect directly to PostgreSQL.
- `src/lib/security.ts`: sessions, hashing, origin validation, rate limiting, input sanitization, and error handling.
- `src/lib/drive-access.ts`: ownership and explicit-recipient permission checks, folder ancestry, and duplicate naming.
- `src/lib/drive-mutations.ts`: real CRUD, recursive folder operations, soft deletion, restoration, copying, and quota checks.
- `src/lib/storage.ts`: interchangeable private local-disk and Supabase adapters.
- `src/db/schema.ts`: canonical Drizzle schema. SQL migrations are in `drizzle/` and `supabase/migrations/`.

### Data relationships

`users` own files, folders, storage usage, sessions, pending uploads, and activity. Folders have optional parent folders, and files have an optional folder. `file_shares` reference exactly one file or folder, an owner, and optionally a registered recipient. Folder shares inherit access through descendants. `share_grants` are short-lived password-unlock sessions. `rate_limits` persist sensitive-endpoint limits across server workers.

Foreign keys, cascade behavior, indexes, nonnegative storage constraints, valid share permissions, and one-target-only share constraints are defined in Drizzle. Files and folders use `deleted_at` and a trash-batch identifier so restoring a deleted folder does not accidentally restore files previously trashed separately. Usage includes trash. Permanent deletion removes file bytes and metadata; folder deletion is recursive.

### Frontend/backend communication

- `POST /api/auth`: initialize an isolated guest workspace, register, login, logout, profile update, or recover/reset an account.
- `GET /api/drive`: paginated, server-filtered collection with `view`, `q`, `filter`, `sort`, `folderId`, and `page`. The search is debounced in the browser. `tree=1` lists destination folders.
- `POST /api/drive`: create-folder, rename, star, delete, restore, permanent, move, copy, or record a recent open.
- `POST /api/uploads`: initialize or finalize an upload. `PATCH /api/uploads?id=...` appends a validated local chunk, with `X-Upload-Offset`. `DELETE` cancels an upload.
- `GET /api/files/:id/content`: authorized inline preview, byte-range media response, or download. Cloud access redirects to a short-lived signed URL.
- `GET/POST/DELETE /api/shares`: list, create, and revoke owner-controlled links.
- `GET/POST/PATCH /api/share/:token`: read a public share, unlock a password, or perform an editor-authorized rename.
- `GET /api/health`: PostgreSQL-backed healthcheck.

### Storage strategy

Local uploads transfer in 5 MiB chunks and resume from the last acknowledged offset. Browser fingerprints and pending-upload rows let a retry resume after interruptions. Chunk writes are serialized by PostgreSQL row locks and bounded by the declared file size. The local per-file maximum is 250 MiB. Supabase uploads use TUS with 6 MiB chunks, retry delays, resume fingerprints, and scoped signed upload tokens. Cloud limits are also subject to your Supabase project and bucket plan. Finalization verifies object size and file signatures before creating a file record. Original upload MIME headers are not trusted; the server derives an approved MIME type from the extension.

Quota checks reserve pending-upload capacity, lock storage rows, and verify space again when committing uploads or copies. Duplicate names receive a numeric suffix. Interrupted files have no visible file record and cannot be fetched through content endpoints. Expired pending uploads for a user are cleaned up when they next initialize an upload.

Never deploy local storage to an ephemeral serverless filesystem. Mount a persistent, private volume (and use shared durable storage for multiple replicas), or configure Supabase. Back up both PostgreSQL and file storage together. A database backup alone does not include file contents.

## Permissions and security

- Every private API request checks an unexpired hashed session, ownership, or an active explicit-recipient share. Editors can rename; viewers can only preview and download. Owner-only operations include destructive changes, moving, copying, and access management.
- Public shares use 256-bit random tokens; only SHA-256 hashes are stored. Optional share passwords use salted scrypt hashes. Expiry, revocation, trash status, target scope, and permission are rechecked server-side on every protected request.
- Password unlock creates an HttpOnly, SameSite, one-hour grant, bounded by share expiry. Revoking a share invalidates subsequent checks immediately. A cloud signed download already issued remains valid for at most sixty seconds, the standard short-lived signed-URL tradeoff.
- Supabase migrations enable RLS for all application tables, isolate secrets and internal tables from PostgREST, and give authenticated roles read-only metadata access through ownership/inherited-sharing policies. Mutations go through this validated server API. Object uploads use narrow server-generated capabilities rather than broad client storage-write policies.
- Executables and active HTML/JavaScript uploads are rejected. Known image, PDF, Office/ZIP, and text signatures are validated. SVG is served with a sandboxed restrictive CSP. Responses set nosniff; unsafe/unsupported types are attachments. Previews never inject uploaded markup into the application DOM.
- Same-origin mutation validation and persisted rate limits protect sensitive routes. Input names reject control characters and path separators. Storage paths use server-generated UUIDs rather than user filenames.
- Cookies are HttpOnly, SameSite=Lax, and Secure in production. Use HTTPS and a correctly configured reverse proxy. Configure your edge proxy to replace—not append arbitrary client-provided—forwarded IP/host headers, enforce request-body limits, and add deployment-appropriate rate limits.
- The server PostgreSQL role must be private and able to perform validated backend operations (for Supabase, a privileged server connection). Never expose it to clients. RLS is a second boundary for direct Supabase access, not a substitute for API authorization.

For an internet-facing production installation, also add malware scanning appropriate to your threat model, a background lifecycle job for expired guests/sessions/grants/pending objects, monitoring, backups, and stronger edge bot controls for guest-workspace creation. This is not a billing-enabled product; Explore Filebox Pro honestly explains administrator-controlled capacity rather than collecting a pretend payment.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | Private PostgreSQL connection used by Drizzle and migrations |
| `SUPABASE_URL` | Cloud only | Supabase project URL |
| `SUPABASE_ANON_KEY` | Cloud auth | Server-side Auth SDK key; not bundled into client code |
| `SUPABASE_SERVICE_ROLE_KEY` | Cloud storage | Private Storage SDK credential, server-only |
| `SUPABASE_STORAGE_BUCKET` | Optional | Private bucket name, default `filebox` |
| `FILE_STORAGE_DIR` | Local storage | Private persistent file directory |
| `DEFAULT_STORAGE_QUOTA` | Optional | Default account quota in bytes, default 5 GiB |
| `APP_URL` | Recommended | Canonical public deployment origin |

Set `DEFAULT_STORAGE_QUOTA` before creating accounts. Existing per-user quotas are persisted in `storage_usage` and require an explicit administrator update.

## Validation and tests

Run:

- `npx next typegen`
- `npm exec tsc -- --noEmit --pretty false`
- `npm run build`
- `node scripts/smoke-test.mjs` against a running app (`TEST_BASE_URL` defaults to `http://localhost:3000`). This creates isolated test accounts and checks database listings, private-file isolation, chunked upload, content integrity, duplicate names, move/copy/trash/restore/delete, quota accounting, viewer/editor permissions, password-protected and revoked shares, local login, and recovery.
- `node scripts/browser-test.mjs` runs desktop/mobile browser workflows and saves screenshots under `artifacts/`. It uses `@playwright/test`; install Chromium and its system libraries with `npx playwright install --with-deps chromium`.

Tests create a small amount of real data; run against a test database, not a live customer installation.

## Deployment

Use a Node.js host or container with access to PostgreSQL. Install dependencies, apply the migrations before serving traffic, run the production build, and start the application using the host's process manager. Expose port 3000 through HTTPS. Configure `/api/health` as the healthcheck. For local storage, mount `FILE_STORAGE_DIR` as a persistent private volume; for ephemeral platforms, choose Supabase. Keep all secrets in your deployment secret manager and restrict direct database networking. The `.env` and private storage directories are ignored by Git.

## Sample assets

The sample photography is from Pexels: Guangxi Liu (desert), Markus Spiske (alpine lake), and Stephen Andrews (architecture). Originals are downloaded into `seed-assets/` and copied into each guest's private storage, not exposed as public account files. The PDF is a valid, generated brand-book document; CSV, Markdown, text, SVG, and JSON samples contain real downloadable content.
