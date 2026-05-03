# Repository Guidelines

## Tech Stack

- TypeScript
- Runtime: Bun
- Package Manager: Bun
- Build: Bun
- Linter: Oxlint
- Formatter: Oxfmt

## Project Structure & Module Organization

Application code lives in `src/`: `index.ts` is the Hono server, `client.tsx` is the browser entry, `root-view.ts` renders the HTML shell, and `pages/` contains page components. Browser output is built to `public/client.js`; notes live in `docs/`.

## Development Commands

- `bun run dev`: build and start the hot-reload server at `http://localhost:3000`.
- `bun run build`: bundle `src/client.tsx` into `public/`.
- `bun run lint` / `bun run lint:fix`: check or fix Oxlint issues.
- `bun run fmt` / `bun run fmt:check`: format or verify formatting with Oxfmt.

## Coding Style & Naming Conventions

Use strict TypeScript and Hono JSX. Prefer two-space indentation, extensionless relative imports, kebab-case filenames such as `root-view.ts`, and PascalCase component names such as `Root`.

## Testing Guidelines

No test script is defined yet. When adding tests, prefer Bun test with colocated `*.test.ts` or `*.test.tsx` files and add a `test` script. Run `bun run fmt:check` and `bun run lint` before PRs.
