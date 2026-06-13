# Detailed Scanning and Approval Script

## Script location

The complete maintenance script is at:

```
.claude/skills/github-dependabot-maintain/scripts/maintain-dependabot.py
```

It loads the existing `.github/dependabot.yml`, preserves settings for
directories that are still present, adds missing entries, removes stale entries,
normalizes group names, and waits for explicit approval before writing the file.

## Running the script

Install PyYAML if it is not already available:

```bash
python3 -m pip install pyyaml
```

Then run from the repository root:

```bash
python3 .claude/skills/github-dependabot-maintain/scripts/maintain-dependabot.py
```

## What the script does

1. Checks `git status --porcelain -- .github/dependabot.yml` and stops if there
   are staged or unstaged changes.
2. Parses the existing `dependabot.yml` into directory-indexed text blocks.
3. Scans `projects/*/` and detects the ecosystem from lockfiles.
4. Builds the desired entry list:
   - If a directory already exists in `dependabot.yml`, reuse its settings
     (`schedule`, `open-pull-requests-limit`, `rebase-strategy`, etc.) and only
     normalize `package-ecosystem`, `directory`, and the group name.
   - If a directory is new, create it from the default template.
5. Writes a preview to `.github/dependabot.yml.preview` and shows `diff -u`.
6. Prompts `Apply changes? [y/N]`. If approved, copies the preview to
   `.github/dependabot.yml`, deletes the preview, validates the YAML, and
   rechecks coverage. If not approved, keeps the preview file and exits without
   modifying the config.

## Edge cases

- If a project has both `bun.lock` and `uv.lock`, the script picks `bun` because
  it is checked first. Review the result manually if this happens.
- If no lockfile is found, the directory is excluded from Dependabot.
- If an existing entry points to a directory that no longer exists, it is removed.
- If an existing entry points to a directory whose lockfile is gone, it is removed.
