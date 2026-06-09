# AGENTS.md

Thin router for `edit-vid2`.

## Always

- Reply in Japanese, concise and polite.
- Keep changes small and inside `projects/edit-vid2` unless requested.
- Never commit secrets, tokens, generated media, DB files, or export data.
- State assumptions before non-trivial decisions.
- Use Bun and existing scripts; see [commands](docs/agent/commands.md).
- Avoid `useEffect`; prefer event handlers (`onKeyDown`, `onClick`, etc.) or other alternatives.

## Routes

| Need      | Read                                     |
| --------- | ---------------------------------------- |
| Commands  | `docs/agent/commands.md`                 |
| Overview  | `README.md`                              |
| CI/Docker | `Dockerfile`, `../../docs/about-cicd.md` |
| Source    | `src/`                                   |
| Tests     | `tests/`                                 |
