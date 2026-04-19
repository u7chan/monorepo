# AGENTS.md

Web-based file server built with Bun + Hono + HTMX.
Current features include empty file creation, per-directory Zip download via `/file/archive`, unauthenticated public file serving via `GET /public/*`, and GUI-based user management via `/admin/users`.

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
- `INITIAL_ADMIN_PASSWORD` - Password for the `admin` user on first bootstrap. If unset, a random password is printed to stdout once at startup.
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

When `AUTH_DIR` is set, `createApp()` also creates `AUTH_DIR/users.json` plus `AUTH_DIR/session-secret`. `users.json` is bootstrapped with an `admin` user if the file is absent or empty. On subsequent startups the file is validated (must contain `admin` with `role: "admin"`).

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

`GET /public/*` is unauthenticated and serves passive content (images, audio, PDF, text) directly from `UPLOAD_DIR/public/`.

- Active content is blocked with 403: `text/html`, `application/xhtml+xml`, `image/svg+xml`, and extensions `.html`, `.htm`, `.xhtml`, `.svg`.
- This route bypasses session authentication — it is always accessible.
- Path traversal is detected and blocked at the handler level.

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

## Important

- Path validation prevents directory traversal. Do not bypass this mechanism.
- If auth is enabled, preserve role-based isolation (`user` scoped to own private dir, `admin` global access).
- Archive downloads use the same path validation and role-based scope rules.
- Runtime and Docker images must provide the `zip` command for `/file/archive`.
- Ensure all tests pass with `bun test` before committing.
- Tests use `createTestApp()` from `tests/helpers/createTestApp.ts` — never import `src/index.tsx` directly in tests.
