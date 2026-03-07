# AGENTS.md

Web-based file server built with Bun + Hono + HTMX.
Current features include per-directory Zip download via `/file/archive`.

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

- `src/index.tsx` - Entry point
- `src/middleware/auth.ts` - Auth middleware
- `src/routes/` - Route definitions (api, auth, browse, file)
- `src/api/handlers.tsx` - API handlers
- `src/components/` - JSX components
- `src/utils/` - Utilities
- `tests/` - Tests (auth, read, upload, delete, mkdir, update)

## Environment Variables

- `UPLOAD_DIR` - File storage directory (default: `./tmp`)
- `USERS_FILE` - Path to users JSON file (enables authentication when set)
- `SESSION_SECRET` - Session signing secret (required when `USERS_FILE` is set)
- Use `.env.example` as a template and set values in `.env` for local development (`bun run` loads `.env` automatically)

## Important

- Path validation prevents directory traversal. Do not bypass this mechanism.
- If auth is enabled, keep per-user directory isolation intact.
- Archive downloads must preserve the same path validation and user-scoped directory isolation rules.
- Runtime and Docker images must provide the `zip` command for `/file/archive`.
- Ensure all tests pass with `bun test` before committing.
