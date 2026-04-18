# AGENTS.md

Web-based file server built with Bun + Hono + HTMX.
Current features include empty file creation, per-directory Zip download via `/file/archive`, and unauthenticated public file serving via `GET /public/*`.

## Commands

- `bun install` - Install dependencies
- `bun run dev` - Start dev server
- `bun run lint` - TypeScript check + Biome format
- `bun test` - Run tests
- `bun run hash-password 'password'` - Generate bcrypt hash for USERS_FILE

## Code Style

- TypeScript + JSX (Hono JSX)
- Formatter/Linter: Biome (`biome.json`)
- Indentation: tabs
- Quotes: double quotes

## Structure

- `src/index.tsx` - Entry point (re-exports `createApp()`)
- `src/app.ts` - `createApp()` factory (initializes dirs, wires middleware + routes)
- `src/middleware/auth.ts` - Auth middleware
- `src/routes/` - Route definitions (api, auth, browse, file, public)
- `src/api/handlers.tsx` - API handlers
- `src/components/` - JSX components
- `src/utils/` - Utilities (incl. `virtualPath.ts` for scope resolution)
- `tests/` - Tests (auth, read, upload, create-file, delete, mkdir, update, rename, public-route)
- `tests/helpers/` - `createTestApp.ts` and `auth.ts` helpers

## Environment Variables

- `UPLOAD_DIR` - File storage root directory (default: `./tmp`)
- `USERS_FILE` - Path to users JSON file (enables authentication when set)
- `SESSION_SECRET` - Session signing secret (required when `USERS_FILE` is set)
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

## Authentication Roles

- `USERS_FILE` entries must include `role` with `"user"` or `"admin"`.
- `user`: restricted to `UPLOAD_DIR/private/<username>/`. Cannot access other users' directories.
- `admin`: full access to `UPLOAD_DIR` (all scopes and users).
- Session stores only `username`; role is reloaded from `USERS_FILE` on each request.
- Reserved usernames `public` and `private` are rejected by `isValidUsername`.

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
