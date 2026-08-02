# OpenAPI Documentation Design

## Context

`apps/api` (NestJS) currently has no OpenAPI/Swagger integration. It exposes 6 controllers and 18 endpoints (documents, folders, permissions, audit, users, health), all protected by a Keycloak-issued JWT Bearer token (`AuthGuard('jwt')`) except `health`. Requests are validated by 3 existing `class-validator` DTOs (`CreateDocumentDto`, `CreateFolderDto`, `GrantPermissionDto`); no response shape has ever been formally defined anywhere in the codebase — controllers return whatever their service methods return (typically a Prisma model shape or a small derived object).

## Purpose

Lay a solid OpenAPI foundation, primarily so people building the internal React frontend have an accurate, browsable reference instead of reading controller/service source to infer request/response shapes. A concrete external-integration use case isn't decided yet, so this work deliberately produces a complete, correct spec without committing to any external exposure decision — that choice can be made later without redoing this work.

## Architecture

Use the official `@nestjs/swagger` package with its **CLI plugin** enabled (`nest-cli.json`: `"plugins": ["@nestjs/swagger"]`). The plugin introspects existing TypeScript types and `class-validator` decorators at compile time and auto-generates most Swagger metadata, so the 3 existing request DTOs need little to no manual annotation — `@ApiProperty()` is only added by hand where a field needs an example value or a description beyond what the type/validator already implies. This is the NestJS-recommended approach, minimizes boilerplate and duplication versus manually annotating every field, and requires no change to how the project already compiles (`nest build`).

## Scope

All 6 controllers, all 18 endpoints:

| Controller | Endpoints |
|---|---|
| `documents` | `POST /documents`, `POST /documents/:id/versions`, `GET /documents/:id/versions`, `GET /documents/:id`, `GET /documents/:id/download` |
| `folders` | `POST /folders`, `GET /folders/:id` |
| `permissions` | `POST /folders/:id/permissions`, `GET /folders/:id/permissions`, `DELETE /folders/:id/permissions/:permissionId`, `POST /documents/:id/permissions`, `GET /documents/:id/permissions`, `DELETE /documents/:id/permissions/:permissionId` |
| `audit` | `GET /folders/:id/audit-logs`, `GET /documents/:id/audit-logs`, `GET /audit-logs/verify` |
| `users` | `GET /whoami` |
| `health` | `GET /` |

Every endpoint gets a response DTO class, matched to what its service method actually returns today (e.g. `FolderResponseDto`, `DocumentResponseDto`, `DocumentVersionResponseDto`, `PermissionResponseDto`, `AuditLogResponseDto`, a chain-verification result DTO for `/audit-logs/verify`, etc. — the exact set and field lists are worked out at plan-writing time by reading each service method's real return shape), annotated via `@ApiResponse({ status, type })` and covering the realistic error status codes each endpoint can actually throw (400/403/404/413/503 etc., per what Phase 2B/3/4B's existing exception handling already produces).

This is documentation-only: response DTOs describe the existing return shape, they do not change any endpoint's actual behavior, status codes, or payload. No service-layer or business-logic changes.

## Authentication

Register a single global `Bearer` security scheme via `DocumentBuilder().addBearerAuth()`, and add `@ApiBearerAuth()` to every controller currently guarded by `AuthGuard('jwt')` (all except `health`). This makes Swagger UI's "Authorize" button work against real Keycloak-issued access tokens, so a developer can authenticate once in the UI and try real requests without manually constructing headers.

## Exposure

`SwaggerModule.setup()` (and the JSON spec endpoint it registers alongside the UI) is mounted only when `process.env.NODE_ENV !== 'production'`. In production the route is never registered at all — not present-but-blocked, genuinely absent, minimizing attack surface for a confidential-document system. `docker-compose.yml`'s `api` service environment is checked/updated so local/dev stacks have `NODE_ENV` set appropriately for the docs to be reachable there. Whether to ever expose this in production, or to a real external integration partner, is an explicit future decision, out of scope here.

## Testing / Verification

Consistent with this project's established "verify against the real running stack" convention (no mocking of infrastructure, no trusting a build succeeding as proof of correctness):

- Boot the dev stack, fetch the real JSON spec endpoint, confirm it's valid OpenAPI 3.0 (structurally, not just "200 OK").
- Open the real Swagger UI, authenticate via the "Authorize" button using a real Keycloak-issued token, and exercise at least 1-2 endpoints for real (e.g. create a folder, upload a document) to confirm the documented request/response shapes match actual live behavior, not just what the DTOs claim.
- Confirm that with `NODE_ENV=production`, `/api-docs` (and the JSON spec route) genuinely 404s.
- Run the full existing lint/build/unit/e2e suite to confirm the new response DTOs introduce no regressions anywhere.

## Out of Scope

- Any change to actual endpoint behavior, request/response payload shape, or status codes — this phase only formally documents what already exists.
- Deciding whether/how to expose this to real external integrators, or generating a frontend client SDK from the spec — both explicitly deferred to a future decision once a concrete need exists.
- API versioning strategy.
