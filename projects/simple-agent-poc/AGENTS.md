# AGENTS.md

## Tech Stack

- [CLAUDE.md](./CLAUDE.md)

## Architecture

- [architecture/SKILL.md](.claude/skills/architecture/SKILL.md)

### Multi-entry boundary policy

- Keep CLI input/output concerns in adapters, not in reusable application flows.
- Add shared execution logic under application use cases with explicit DTOs.
- Keep entrypoints thin and focused on wiring.
- Use `.claude/skills/architecture/SKILL.md` as the reference for follow-up refactors.

## Development

- [development/SKILL.md](.claude/skills/development/SKILL.md)

## Testing

- [testing/SKILL.md](.claude/skills/testing/SKILL.md)
