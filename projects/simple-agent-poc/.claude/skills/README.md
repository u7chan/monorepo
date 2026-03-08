# Skills README

This file is a human-facing index for navigating project skills and references.
Do not treat it as a required one-shot load target for agents; open only the specific linked files you need.

## Tech Stack

- [CLAUDE.md](../../CLAUDE.md)

## Architecture

- [architecture/SKILL.md](./architecture/SKILL.md)

### Multi-entry boundary policy

- Keep CLI input/output concerns in adapters, not in reusable application flows.
- Add shared execution logic under application use cases with explicit DTOs.
- Keep entrypoints thin and focused on wiring.
- Use `./architecture/SKILL.md` as the reference for follow-up refactors.

## Development

- [development/SKILL.md](./development/SKILL.md)

## Testing

- [testing/SKILL.md](./testing/SKILL.md)
