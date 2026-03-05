# AGENTS.md

Web-based file server built with Bun + Hono + HTMX.

## Commands

- `bun install` - Install dependencies
- `bun run dev` - Start dev server
- `bun run lint` - TypeScript check + Biome format
- `bun test` - Run tests

## Code Style

- TypeScript + JSX (Hono JSX)
- Formatter/Linter: Biome (`biome.json`)
- Indentation: tabs
- Quotes: double quotes

## Structure

- `src/index.tsx` - Entry point
- `src/routes/` - Route definitions (api, browse, file)
- `src/api/handlers.tsx` - API handlers
- `src/components/` - JSX components
- `src/utils/` - Utilities
- `tests/` - Tests (read, upload, delete, mkdir)

## Environment Variables

- `UPLOAD_DIR` - File storage directory (default: `./tmp`)

## Important

- Path validation prevents directory traversal. Do not bypass this mechanism.
- Ensure all tests pass with `bun test` before committing.
