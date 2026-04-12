# AGENTS.md

## Tech Stack

| Item               | Stack                   |
| ------------------ | ----------------------- |
| Language           | TypeScript              |
| Runtime            | Node                    |
| Package Manager    | Bun                     |
| Linter & Formatter | Oxlint / Oxfmt          |
| CSS Styling        | Tailwind CSS            |
| Build & Bundler    | Vite                    |
| Backend            | Hono                    |
| Frontend           | React (SPA)             |
| Testing            | Vitest                  |
| Routing            | TanStack Router         |
| Database           | PostgreSQL              |
| ORM                | Drizzle ORM             |
| Dev Environment    | Dev Containers (VSCode) |

For development commands and operational procedures, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Code style

- TypeScript strict mode
- Single quotes, no semicolons
- Tab width: 2 spaces
- Print width: 120
- Trailing comma: es5
- End of line: lf

## Linting & Formatting

- **Lint**: `bun run lint`
- **Format**: `bun run format`

## Test

- **Test**: `bun run test`
- **Test Coverage**: `bun run test:coverage`

## Why / What / Constraints First

Before implementation, clarify the following concisely as needed.

- **Why**: Why it is needed
- **What**: What must be satisfied
- **Constraints**: Assumptions and constraints to follow

**How** refers to the implementation itself and is intentionally excluded here.  
Express How through design and code.

## Test Policy

- Design test cases as living documentation (specifications).
- Each test file has a top-level `describe` naming the module, command, or use case.
- Use `it()` for test cases; names should not repeat context already in `describe` — lead with the expected result or failure condition.
- 1–3 tests with a single responsibility: one level of `describe`.
- 4+ tests or multiple responsibilities: use nested `describe` to separate concerns; headings alone should convey the boundary.
- Nested `describe` splits by public function, responsibility, or user-facing behavior — not by implementation detail.

## Review Policy

- Always review in Japanese.
