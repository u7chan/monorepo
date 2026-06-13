---
name: github-dependabot-maintain
description: >
  When asked to maintain `.github/dependabot.yml` or keep Dependabot entries in sync with `projects/`,
  scan project directories, detect ecosystems from lockfiles, and propose updates.
---

# Dependabot Config Maintenance

## Overview

Keep `.github/dependabot.yml` in sync with the actual `projects/` layout.
Adds missing Dependabot entries, removes stale entries, normalizes group names,
and sorts entries alphabetically by `directory`.

## When to Use This Skill

- When told "dependabot.yml をメンテして" or "update dependabot config"
- When a new project is added under `projects/`
- When a project is removed or no longer has a lockfile
- Before opening a PR that adds/removes/renames a project under `projects/`

## What the Agent Does

1. Verify `.github/dependabot.yml` has no uncommitted changes
2. Scan immediate subdirectories of `projects/`
3. Detect each project's ecosystem from its lockfile
4. Compare scan results with existing `updates:` entries
5. Add missing entries, remove stale entries, normalize group names, and sort
6. Show the diff and ask for approval
7. Write the file only after approval
8. Validate YAML syntax and recheck coverage

## Input and Output

**Input:**
- `.github/dependabot.yml`
- `projects/*/` directories and their lockfiles

**Output:**
- Updated `.github/dependabot.yml` (after user approval)

## Exclusions

Ignore these directories under `projects/`:

- `_labs/`
- `_samples/`
- Nested subdirectories
- Any directory without a recognized lockfile

## Ecosystem Detection

Use lockfiles only:

| Lockfile | Ecosystem |
|----------|-----------|
| `bun.lock` or `bun.lockb` | `bun` |
| `uv.lock` | `uv` |

## Step Details

### Step 1: Check for Uncommitted Changes

Before editing, run:

    git diff -- .github/dependabot.yml

If there are uncommitted changes, stop and warn the user.

### Step 2: Scan Projects

List candidate directories:

    for dir in projects/*/; do
      name=$(basename "$dir")
      [[ "$name" == "_labs" || "$name" == "_samples" ]] && continue
      if [[ -f "$dir/bun.lock" || -f "$dir/bun.lockb" ]]; then
        echo "bun /projects/$name"
      elif [[ -f "$dir/uv.lock" ]]; then
        echo "uv /projects/$name"
      fi
    done | sort -k2

### Step 3: Build Desired Entries

For each detected project, build an entry:

    - package-ecosystem: "{ecosystem}"
      directory: "/projects/{name}"
      schedule:
        interval: "weekly"
      open-pull-requests-limit: 1
      rebase-strategy: "disabled"
      groups:
        {name}-minor-and-patch:
          applies-to: version-updates
          patterns:
            - "*"
          update-types:
            - "minor"
            - "patch"

Use the exact project directory name as the group name prefix.
Keep a blank line between entries to match the current file format.

### Step 4: Preserve Existing Settings

When an entry already exists for a scanned directory, keep its existing values for:

- `schedule`
- `open-pull-requests-limit`
- `rebase-strategy`
- any other custom fields

Only normalize the group name to `{name}-minor-and-patch` if it differs.

### Step 5: Diff and Propose

Compare desired entries with the current file. Show the diff and wait for user approval.
Do not write the file if the user does not explicitly approve.

### Step 6: Write and Validate

After approval, write `.github/dependabot.yml`. Then run:

    python3 -c "import yaml; yaml.safe_load(open('.github/dependabot.yml'))"

Finally, rerun the scan from Step 2 and confirm every detected project has exactly one entry.

## Quality Check

- [ ] No uncommitted changes existed before editing
- [ ] Only `projects/` immediate subdirectories were scanned
- [ ] `_labs/` and `_samples/` were excluded
- [ ] Ecosystems were detected from lockfiles
- [ ] Existing entry settings were preserved except group names
- [ ] Entries are sorted alphabetically by `directory`
- [ ] User approved the diff before writing
- [ ] YAML syntax passes `python3 -c "import yaml; yaml.safe_load(...)"`
- [ ] Scan results and entries are 1:1 after writing

## References

- `.github/dependabot.yml` - the file this skill maintains
- `references/github-dependabot-maintain-detailed.md` - detailed scanning and approval script
