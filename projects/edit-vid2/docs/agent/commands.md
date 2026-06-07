# Agent Commands

Run from `projects/edit-vid2`.

## Bun

- Install: `bun install`
- Dev: `bun run dev`
- Typegen: `bun run typegen`
- Lint: `bun run lint`
- Format check: `bun run format:check`
- Format: `bun run format`
- Test: `bun test`
- Build: `bun run build`
- Start: `bun run start`

## DB

- Generate: `bun run db:generate`
- Migrate: `bun run db:migrate`

## Docker

- CI test: `docker build --target test -t edit-vid2-test .`
- Image: `docker build -t edit-vid2 .`
