# Agent Commands

Run from the target project root unless noted. Prefer `package.json` / project scripts.

## Bun

- Install: `bun install`
- Lint: `bun run lint`
- Format check: `bun run format:check`
- Format: `bun run format`
- Test: `bun test` or `bun run test`
- Build: `bun run build`

## Docker CI

- Test stage: `docker build --target test -t <name>-test <project-dir>`
- Final stage: `docker build --target final -t <name> <project-dir>`

## Licenses

- Target: `./scripts/check-licenses --target <manifest-root>`
- Changed targets: `./scripts/check-licenses --changed-targets-file <file>`
- Policy: `./scripts/check-licenses --validate-policy`
- Script tests: `python -m unittest discover scripts/tests -p 'test_check_licenses.py'`
