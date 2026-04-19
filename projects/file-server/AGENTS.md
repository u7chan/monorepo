# AGENTS.md

Web-based file server built with Bun + Hono + HTMX.
Current features include empty file creation, per-directory Zip download via `/file/archive`, unauthenticated public file serving via `GET /public/*`, and GUI-based user management via `/admin/users`.

## File Raw and Download Routes

- `GET /file/raw` — preview-only route. Blocks `text/html`, `application/xhtml+xml`, `image/svg+xml`, and extensions `.html`, `.htm`, `.xhtml`, `.svg` with `403`. SVG is treated as source view (not embedded image) and is also blocked. Existing image/video/PDF preview behavior is preserved.
- `GET /file/download` — download route. Always returns `Content-Disposition: attachment`. Supports all file types including HTML and SVG. Applies the same path validation and authorization rules as other file routes.

## Commands

- `bun install` - Install dependencies
- `bun run dev` - Start dev server
- `bun run lint` - TypeScript check + Biome format
- `bun test` - Run tests
- `bun run hash-password 'password'` - Generate bcrypt hash (for manual recovery/testing)

## Code Style

- TypeScript + JSX (Hono JSX)
- Formatter/Linter: Biome (`biome.json`)
- Indentation: tabs
- Quotes: double quotes

## Structure

- `src/index.tsx` - Entry point (re-exports `createApp()`)
- `src/app.ts` - `createApp()` factory (initializes dirs, wires middleware + routes)
- `src/middleware/auth.ts` - Auth middleware
- `src/routes/` - Route definitions (admin, api, auth, browse, file, public)
- `src/api/handlers.tsx` - API handlers
- `src/components/` - JSX components
- `src/utils/` - Utilities (incl. `virtualPath.ts` for scope resolution)
- `tests/` - Tests (auth, read, upload, create-file, delete, mkdir, update, rename, public-route)
- `tests/helpers/` - `createTestApp.ts` and `auth.ts` helpers

## Environment Variables

- `UPLOAD_DIR` - File storage root directory (default: `./tmp`)
- `AUTH_DIR` - Authentication metadata directory. Setting this enables authentication and stores `users.json` plus `session-secret`.
- `INITIAL_ADMIN_PASSWORD` - Password for the `admin` user on first bootstrap only. If `users.json` already contains a valid `admin`, this value is ignored. If unset, a random password is printed to stdout once at startup.
- Use `.env.example` as a template and set values in `.env` for local development (`bun run` loads `.env` automatically)

## Directory Layout

`UPLOAD_DIR` is structured into two top-level scopes:

```
UPLOAD_DIR/
├── public/     # Publicly accessible files (served via GET /public/*)
└── private/    # User-scoped private files
    ├── alice/
    └── bob/
```

`createApp()` creates both directories at startup if they do not exist.

When `AUTH_DIR` is set, `createApp()` also creates `AUTH_DIR/users.json` plus `AUTH_DIR/session-secret`. `users.json` is bootstrapped with an `admin` user if the file is absent or empty. On subsequent startups the file is validated (must contain `admin` with `role: "admin"`), and `INITIAL_ADMIN_PASSWORD` is ignored once a valid admin already exists.

**Docker / Docker Compose**: mount `AUTH_DIR` as a persistent volume so `users.json` and `session-secret` survive container restarts.

## Virtual Path Resolution

All browse/API requests use a virtual path that maps to one of two scopes:

| Virtual path | Auth disabled | Auth enabled (user) | Auth enabled (admin) |
|---|---|---|---|
| `` (root) | synthetic `[public, private]` | synthetic `[public, private]` | synthetic `[public, private]` |
| `public/...` | resolved → `UPLOAD_DIR/public/...` | resolved → `UPLOAD_DIR/public/...` | resolved → `UPLOAD_DIR/public/...` |
| `private` | resolved → `UPLOAD_DIR/private/` | synthetic `[<username>]` | resolved → `UPLOAD_DIR/private/` |
| `private/<username>/...` | resolved | allowed only for own username | allowed for any username |
| `private/<other-user>/...` | resolved | 403 Forbidden | allowed |

## Public Route

`GET /public/*` is unauthenticated and serves files directly from `UPLOAD_DIR/public/`, including HTML, XHTML, and SVG.

- **Trusted content premise**: HTML/XHTML/SVG delivery via `/public/*` assumes the content was placed there by an explicit user action or a user-confirmed Internal API call. This is not a mechanism for safely hosting untrusted content on the same origin.
- Active content (HTML/XHTML/SVG) is served with its native MIME type. Sanitization and XSS prevention are enforced at upload/update/rename time via server-side validation (see Issue #815 / `src/utils/htmlValidation.ts`), not at delivery time.
- **Admin-only write for active content**: When auth is enabled, only `admin`-role users can upload, update, or rename files to HTML/XHTML/SVG extensions in the `public/` scope. Regular `user`-role requests are rejected with 403. In auth-disabled (anonymous) mode this restriction does not apply.
- This route bypasses session authentication — it is always accessible.
- Path traversal is detected and blocked at the handler level.
- Directories are rejected with 404.

## File Viewer Behavior for HTML/SVG

| Scope | Source view | Public URL button | Download button |
|---|---|---|---|
| `public/` | ✓ | ✓ (opens `/public/...` in new tab) | ✓ |
| `private/` | ✓ | — | ✓ |

- HTML/XHTML/SVG files are always shown as source (text) in the viewer, regardless of scope.
- The public URL button appears only for `public/` HTML/XHTML/SVG files and opens the rendered page at `/public/...` in a new tab.
- Path segments are percent-encoded in the generated public URL (supports spaces, Japanese characters, `#`, `?`, etc.).

## Authentication

Authentication is enabled when `AUTH_DIR` is set. Users are stored in `AUTH_DIR/users.json`, and the session signing key is stored in `AUTH_DIR/session-secret`.

### Roles

- `user`: restricted to `UPLOAD_DIR/private/<username>/`. Cannot access other users' directories.
- `admin`: full access to `UPLOAD_DIR` (all scopes and users). Can manage users via `/admin/users`.

### Master Admin

- Username `admin` is the master admin: deletion-protected and role-change-protected.
- Changing `admin`'s own password requires the current password.
- `AUTH_DIR/users.json` must always contain `admin` with `role: "admin"` when non-empty; otherwise startup fails.

### Session Versioning

Users have a `sessionVersion` counter stored in `users.json`. It is embedded in the session cookie. On password change, role change, or role update the counter increments, invalidating all previous sessions for that user.

### User Management GUI

`GET /admin/users` — accessible to admin-role users only. Provides:
- Create user (username, password, role)
- Change role (non-master-admin users)
- Reset password (other users)
- Delete user (non-master-admin users)
- Change own password (requires current password; re-issues session cookie)

Reserved usernames `public` and `private` are rejected by `isValidUsername`.

## Migration Guide (from pre-Issue-#806)

If you have an existing `UPLOAD_DIR` with files at `UPLOAD_DIR/<username>/`, move them:

```bash
mkdir -p UPLOAD_DIR/private
mv UPLOAD_DIR/<username> UPLOAD_DIR/private/<username>
```

API paths also change:
- Old: `GET /api/` → user's root files
- New: `GET /api/private/<username>/` → user's files
- Old: `GET /api/` (admin) → all user dirs
- New: `GET /api/private/` (admin) → all user dirs

## Public HTML/SVG Validation (Issue #815)

`POST /api/upload` and `POST /api/update` apply server-side validation when saving HTML/XHTML/SVG files (`.html`, `.htm`, `.xhtml`, `.svg`) to the `public/` scope.

- This is a **trusted content** guardrail. It is not a mechanism to safely host untrusted content on the same origin.
- Validation is implemented in `src/utils/htmlValidation.ts` (`validatePublicHtml`).
- The following are rejected: `<script>`, `on*` event handler attributes, `javascript:` URLs, `<iframe>`, `<object>`, `<embed>`, `meta[http-equiv]`, `<foreignObject>`.
- On upload failure, the file appears in the `failed` array with a `reason` field.
- On update failure, a `400 ValidationError` response is returned.
- Files in `private/` scope are not validated.
- Non-HTML/SVG files are not validated regardless of scope.

## Important

- Path validation prevents directory traversal. Do not bypass this mechanism.
- If auth is enabled, preserve role-based isolation (`user` scoped to own private dir, `admin` global access).
- Archive downloads use the same path validation and role-based scope rules.
- Runtime and Docker images must provide the `zip` command for `/file/archive`.
- Ensure all tests pass with `bun test` before committing.
- Tests use `createTestApp()` from `tests/helpers/createTestApp.ts` — never import `src/index.tsx` directly in tests.
