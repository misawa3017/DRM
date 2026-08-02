# Phase 4C: Watermarking & Expiration Design

## Context

This is the third and final sub-phase of the original Phase 4 split (4A infrastructure / 4B upload pipeline integration / 4C watermarking + expiration), both already complete. It implements the last two v1 features named in the original system design spec (`docs/superpowers/specs/2026-07-31-confidential-document-management-design.md`): dynamic watermarking and document expiration/auto-invalidation.

Since the original spec was written, Phase 4B established a firm architectural principle: `apps/worker` never touches Postgres directly; `apps/api` is the sole owner of all database writes, including background-job outcomes. This design deliberately deviates from the original spec's literal wording in one place (the expiration sweep mechanism) to stay consistent with that now-reviewed principle — see below.

## Architecture

**Expiration sweep**: the original spec called for a worker-side BullMQ repeatable job. Instead, this uses `@nestjs/schedule`'s `@Cron` decorator running directly inside `apps/api`. The sweep is a pure "query Postgres, update status" operation with no need for any external service the worker exists to reach (MinIO, Gotenberg, ClamAV), so there's no reason to route it through the worker and reintroduce a database dependency there — the exact Dockerfile/Prisma complications Phase 4B's review flagged and avoided. A single `apps/api` instance runs the cron; this is a documented limitation if the deployment is ever horizontally scaled to multiple `api` replicas (out of scope for this v1 single-VM deployment — see Out of Scope).

**Watermarking**: never pre-generated, never cached. Every `GET /documents/:id/download` request that resolves to a watermark-eligible PDF gets the watermark overlaid on-the-fly via `pdf-lib` before the response is sent.

## Data Model Changes

`Document` model gains:
- `expiresAt DateTime?` — nullable; `null` means never expires.
- `status DocumentStatus` — new enum `active` / `expired`, default `active`.
- `watermarkEnabled Boolean?` — nullable; `null` means "not explicitly set, inherit from the folder chain"; `true`/`false` is an explicit override that stops inheritance at this document.

`Folder` model gains:
- `watermarkEnabled Boolean?` — same nullable/inheritance semantics as the document field.

**Watermark resolution** (`resolveWatermarkEnabled`, mirroring the existing `AclService.resolveLevel` pattern from Phase 2B): start at the document; if its `watermarkEnabled` is non-null, use it. Otherwise walk up the folder chain, using the first non-null `watermarkEnabled` found. If nothing in the chain is explicitly set, default to `true` (watermark on).

`AuditAction` enum gains:
- `document_expired` — written once per document when the daily sweep transitions it to `expired`. Actor is a reserved system identifier (exact representation decided at plan time), not a real user.
- `document_expiry_updated` — written when a `manage`-permission holder sets or changes `expiresAt` via the API.

## Expiration Workflow

- **Setting/modifying**: a `manage`-permission-gated endpoint (exact route decided at plan time, e.g. `PATCH /documents/:id/expiration`) accepts `expiresAt` as an ISO timestamp or `null` (never expires). If the document's current `status` is `expired` and the new `expiresAt` is in the future (or `null`), this call also flips `status` back to `active` — this is the only way to "un-expire" a document. Writes `document_expiry_updated`.
- **Daily sweep**: `apps/api`'s `@Cron` (e.g. 02:00 daily) queries all documents where `status = active AND expiresAt < now()`, sets `status = expired` for each, and writes one `document_expired` audit entry per document.
- **Enforcement scope**: only content-related endpoints are blocked when `status = expired` — `download`, `getMetadata`, `listVersions`, `addVersion` all return a clear error (exact status code, 403 or 410, decided at plan time) with a message stating the document has expired. Permission management (`grant`/`revoke`) is unaffected — a `manage`-permission holder can still adjust ACLs or extend `expiresAt` on an expired document.
- Nothing is ever deleted. ACL grants and the full audit history survive expiration unchanged — expiration is purely a status flag.

## Watermarking Workflow

Applies only at the single file-content endpoint, `GET /documents/:id/download`, after the existing ACL check and the new expiration check. Resolution order, given the requested document version:

1. **Version's own mimetype is `application/pdf`** and `resolveWatermarkEnabled` is `true` → overlay the watermark on that PDF and return it.
2. **Version has a Phase-4B-generated `previewObjectKey`** (an Office file that's finished converting) and `resolveWatermarkEnabled` is `true` → overlay the watermark on the preview PDF and return it (the response is the converted PDF, not the original Office file — the whole point is that the thing leaving the system is watermark-protected).
3. **Version is an Office mimetype, `resolveWatermarkEnabled` is `true`, but `previewObjectKey` is still `null`** (Phase 4B's async conversion hasn't finished yet) → return a distinct "not ready" error (HTTP 425 Too Early) rather than silently falling back to the unprotected original. This follows the fail-closed precedent Phase 4B's final review established for the virus scanner (an ambiguous/incomplete security-relevant state must never silently degrade to "unprotected but served").
4. **`resolveWatermarkEnabled` is `false`, or the file is a type with no PDF representation at all** (images, plain text, etc.) → return the original file unchanged, unwatermarked.

Watermark content: the downloading user's email, the download timestamp, and their source IP, overlaid on every page of the PDF via `pdf-lib` (exact visual styling — e.g. diagonal semi-transparent text — decided at implementation time). The existing `document_download` audit action already covers this; no new audit action is needed for the act of watermarking itself.

## Testing / Verification

Consistent with this project's "verify against the real running stack, no mocked infrastructure" convention:

- **Expiration**: set a real document's `expiresAt` to the past via Prisma, invoke the sweep logic directly (not by waiting for the real cron schedule), and confirm `status` flips to `expired`, the audit entry is written, and `download`/`getMetadata`/`listVersions`/`addVersion` all reject while `permissions` endpoints still work. Also test extending `expiresAt` on an already-expired document and confirm it reactivates.
- **Watermarking**: upload a real PDF and a real Office document through the full real pipeline (ClamAV scan → MinIO storage → Gotenberg conversion), download each, and verify the returned PDF genuinely contains the watermark text (e.g. the user's email string appears in the extracted PDF content) — not just a 200 status or a size check. Also verify that with `watermarkEnabled=false`, the downloaded bytes are byte-for-byte identical to the original (hash comparison). Cover the folder-inheritance resolution logic with dedicated unit tests, in the style of the existing `AclService` tests. Cover the 425 "not ready yet" path for an Office upload whose conversion hasn't completed.
- Run the full existing lint/build/unit/e2e suite to confirm no regressions.

## Out of Scope

- Horizontal scaling of `apps/api` (the single-instance `@Cron` would double-fire the sweep across multiple replicas) — acceptable for this v1 single-VM Docker Compose deployment; revisit if/when this moves to K8s with multiple API replicas.
- Any UI/frontend work — this phase is backend-only, matching the pattern of Phases 1-4B.
- Folder-level or document-level expiration inheritance — expiration (`expiresAt`/`status`) is document-only; only watermarking uses folder inheritance, per the design above.
- Notifying users before/when a document expires (e.g. email alerts) — not requested, not in the original spec.
