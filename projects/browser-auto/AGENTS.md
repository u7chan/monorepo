# Tech Stack

- Bun
- TypeScript
- Hono
- Playwright
- pino
- React
- Tailwind CSS v4
- oxlint
- oxfmt

# Commands

- `bun run dev`: Start the development server with watch mode.
- `bun run build`: Bundle the React SPA into `dist/client`.
- `bun run lint`: Run oxlint and fail on warnings.
- `bun run format`: Format files with oxfmt.
- `bunx playwright install chromium`: Install Playwright Chromium (required).

# Test Policy

- Design test cases as living documentation (specifications).
- Each test file has a top-level `describe` naming the module, command, or use case.
- Use `it()` for test cases; names should not repeat context already in `describe` — lead with the expected result or failure condition.
- 1–3 tests with a single responsibility: one level of `describe`.
- 4+ tests or multiple responsibilities: use nested `describe` to separate concerns; headings alone should convey the boundary.
- Nested `describe` splits by public function, responsibility, or user-facing behavior — not by implementation detail.
