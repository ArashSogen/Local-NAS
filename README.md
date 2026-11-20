# VaultStage NAS

A self-hosted, multi-user Network Attached Storage (NAS) web application with **local hard disk staging**, **verified rclone cloud synchronization**, and **automatic post-verification staging cleanup**.

Files uploaded by users land on your local staging disk first, are hashed (SHA-256, MD5, SHA-1), queued for bounded-concurrency upload to your configured `rclone` cloud remote, strictly verified on the remote, and removed from the local staging disk **only after verification succeeds**. Once synced, browsing, previewing, and downloading stream directly from the cloud drive through permission-checked server endpoints.

---

## Architecture Overview

- **Backend**: Node.js 22 + Express (`server.ts`, `server/app.ts`) with TypeScript (`tsx`).
- **Database**: SQLite in WAL mode via `better-sqlite3`, managed by ordered SQL migrations in `server/migrations/`.
- **Frontend**: React 19 + Tailwind CSS v4 + Vite (served via `vite.middlewares` in development and static `dist/` in production).
- **Cloud Sync Engine**:
  - `server/cloudDriver.ts`: Uses the official `rclone` CLI (`spawn` with `shell: false`) against your mounted `rclone.conf`. When running in environments without the `rclone` binary and configured with a `type = local` remote, automatically falls back to an `rclone.conf`-compatible local backend driver.
  - `server/syncEngine.ts`: Persistent state machine, bounded-concurrency worker queue, exponential backoff retries, generation-guarded overwrite/rename/delete handling, and startup crash reconciliation.
- **Storage Namespace Isolation**:
  - Local staging: `<HARD_DISK_PATH>/<user_id>/<relative_path>`
  - Cloud drive: `<CLOUD_REMOTE>/<user_id>/<relative_path>`
  - Uses immutable internal user IDs (`usr_<hex>`) rather than usernames. Every path is normalized and checked against lexical traversal (`..`, NUL, encoded traversal) and symlink escapes (`lstat` + `realpath`).

---

## One-Command Quickstart (Docker Compose)

1. (Optional) Create your environment file from the template:
   ```bash
   cp .env.example .env
   # Edit .env to set SECRET_KEY, ADMIN_PASSWORD, HARD_DISK_PATH, and CLOUD_REMOTE
   ```
2. Start the application:
   ```bash
   docker compose up -d
   ```
3. Open `http://localhost:3000` in your browser and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` (default: `admin` / `changeme-admin-123`). You will be required to change the initial administrator password immediately on first login.

> By default, if no external `rclone.conf` is mounted, VaultStage bootstraps a local demo remote (`localcloud:/data/cloud`) so you can test the full stage → sync → verify → delete workflow immediately.

---

## Local Development & Automated Tests

```bash
npm install
npm run dev      # Starts Express + Vite on http://localhost:3000
npm test         # Runs the full automated integration & security test suite
npm run build    # Builds production frontend bundle into dist/
```

---

## Environment Variable Reference

| Variable | Default (Docker) | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP listening port inside the container. |
| `HARD_DISK_PATH` | `/data/staging` | Local staging directory where uploads land first. |
| `CLOUD_REMOTE` | `localcloud:/data/cloud` | `rclone` remote and base path (e.g. `gdrive:nas-storage`, `s3:my-bucket/nas`). |
| `RCLONE_CONFIG_PATH` | `/config/rclone/rclone.conf` | Path to `rclone.conf` inside the container. |
| `DATABASE_URL` | `/data/db/nas.sqlite` | SQLite database file path (`sqlite:///...` also supported). |
| `SECRET_KEY` | *(required in prod)* | Secret used for HMAC-SHA256 session token hashing (`openssl rand -hex 32`). |
| `MAX_UPLOAD_SIZE` | `1073741824` (1 GiB) | Maximum allowed single file size in bytes (also editable at runtime by admin). |
| `DEFAULT_USER_QUOTA` | `5368709120` (5 GiB) | Default storage quota for newly created users (runtime-editable). |
| `UPLOAD_CHUNK_SIZE` | `4194304` (4 MiB) | Chunk size for resumable client uploads (runtime-editable). |
| `SYNC_CONCURRENCY` | `2` | Maximum simultaneous background `rclone` uploads (runtime-editable). |
| `SYNC_RETRY_LIMIT` | `3` | Retry attempts before marking a job `FAILED` (runtime-editable). |
| `SYNC_RETRY_BACKOFF` | `5000` | Base exponential backoff delay in ms; attempt *N* waits `backoff * 2^(N-1)`. |
| `ADMIN_USERNAME` | `admin` | Initial admin username (bootstrapped only if no admin exists). |
| `ADMIN_PASSWORD` | `changeme-admin-123` | Initial admin password; forced to change on first login. |
| `TRUST_PROXY` | `true` | Trust `X-Forwarded-*` headers when running behind a reverse proxy. |
| `SESSION_TTL_HOURS` | `24` | Session cookie expiry duration in hours. |

---

## Configuring a Cloud Remote (`rclone`)

### Option A: Generate `rclone.conf` on your host and mount it

1. Run `rclone config` on any machine (or via Docker):
   ```bash
   mkdir -p ./rclone
   docker run --rm -it -v "$(pwd)/rclone:/config/rclone" rclone/rclone:1.68 config
   ```
2. Follow the interactive prompts to configure your cloud provider (e.g. name it `gdrive`, `s3`, `b2`, `onedrive`, `dropbox`, etc.).
3. Update `docker-compose.yml` to bind-mount your host config directory (read-only if your provider does not require OAuth token refresh; read-write for OAuth providers like Google Drive or OneDrive that rotate refresh tokens):
   ```yaml
   volumes:
     - ./rclone:/config/rclone
   ```
   Ensure the `rclone.conf` file is readable by UID `1001` (`chown -R 1001:1001 ./rclone`).
4. Set `CLOUD_REMOTE` in `.env`:
   ```env
   CLOUD_REMOTE=gdrive:nas-storage
   RCLONE_CONFIG_PATH=/config/rclone/rclone.conf
   ```
5. Restart the service: `docker compose up -d`.

### Option B: Use a local backend (for testing or NAS-to-NAS disk mirroring)

```ini
# ./rclone/rclone.conf
[localcloud]
type = local
```
```env
CLOUD_REMOTE=localcloud:/data/cloud
```

> **Security Note**: `rclone.conf` is never exposed through any API endpoint or log. The Admin Settings UI inspects only the remote name and `type = ...` field.

---

## Upload, Sync, Verify, and Delete Pipeline

Every file progresses through an explicit state machine persisted in SQLite (`files.status` and `sync_jobs.status`):

```text
RECEIVING → STAGED → QUEUED → UPLOADING → VERIFYING → SYNCED (local deleted) | FAILED
```

1. **Chunked Resumable Ingest (`RECEIVING`)**:
   - Client initiates `/api/uploads/init` (validating path safety, `MAX_UPLOAD_SIZE`, and user quota).
   - Chunks stream to `<HARD_DISK_PATH>/.tmp/<upload_id>.part` via `PUT /api/uploads/:id/chunk?offset=<n>`. Partial uploads are never exposed in listings or downloads.
2. **Atomic Staging & Hashing (`STAGED`)**:
   - On `/api/uploads/:id/complete`, the server verifies total byte length, computes **SHA-256, MD5, and SHA-1** in a single streaming pass, and atomically `rename()`s the file into `<HARD_DISK_PATH>/<user_id>/<relative_path>`.
3. **Bounded Background Sync (`QUEUED → UPLOADING`)**:
   - Up to `SYNC_CONCURRENCY` jobs run concurrently via `rclone copyto --no-traverse`.
4. **Strict Verification (`VERIFYING`)**:
   - Queries the remote object via `rclone lsjson --stat --hash`.
   - Confirms the remote object exists and `remote.Size === local.size_bytes`.
   - Compares cryptographic hashes in priority order:
     1. `SHA-256` (if provider reports it, e.g. Local, Dropbox, OneDrive/SharePoint depending on tenant)
     2. `MD5` (e.g. Google Drive, AWS S3 single-part, Backblaze B2, GCS)
     3. `SHA-1` (e.g. OneDrive, Box, Backblaze B2)
   - **Documented Limitation (Fallback)**: If a cloud provider does not expose SHA-256, MD5, or SHA-1 hashes (for example, S3 multipart uploads with non-MD5 ETags or certain WebDAV servers), VaultStage falls back to verifying **exact byte size + remote modification timestamp (`size_mtime`)** and records `verification_method = 'size_mtime'` on the file metadata so users and admins can audit which check was used.
5. **Post-Verification Local Deletion (`SYNCED`)**:
   - **Invariant**: The local staged file is **NEVER** deleted before verification returns `verified = true`.
   - Once verified, DB status transitions to `SYNCED` (`cloud_present = 1`), the local file is unlinked, empty staging subdirectories are pruned, and `local_present` is set to `0`.
6. **Failure & Retry (`FAILED`)**:
   - On upload or verification failure, the job retries with exponential backoff (`SYNC_RETRY_BACKOFF * 2^(attempts - 1)`) up to `SYNC_RETRY_LIMIT`.
   - If retries are exhausted, the file and job are marked `FAILED`, the **local file is preserved untouched**, and the error is surfaced to both the user and admin with one-click retry.
7. **Crash Safety**:
   - On every startup (`reconcileOnStartup()`), VaultStage cleans orphaned `.part` temp files, re-queues jobs interrupted in `UPLOADING` or `VERIFYING` (if the local file exists), finishes cleanup for verified `SYNCED` files that crashed right before unlink, and ensures zero stuck jobs.
8. **Concurrent Overwrites, Renames, and Deletes**:
   - Every file carries a monotonic `generation` counter and `deleted_at` tombstone. If a user overwrites, renames, or deletes a file while a sync job is mid-flight, the old job is cancelled/aborted and verified against `generation` before any DB commit or local deletion.

---

## Deploying Behind HTTPS (Reverse Proxy)

VaultStage NAS runs as an HTTP service on port `3000` and is designed to sit behind a TLS-terminating reverse proxy (`TRUST_PROXY=true`).

### Example: Caddy (Automatic Let's Encrypt HTTPS)

```caddyfile
nas.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### Example: Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name nas.example.com;

    ssl_certificate     /etc/letsencrypt/live/nas.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nas.example.com/privkey.pem;

    # Allow chunk uploads and disable buffering for large cloud streams
    client_max_body_size 128M;
    proxy_request_buffering off;
    proxy_buffering off;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```
