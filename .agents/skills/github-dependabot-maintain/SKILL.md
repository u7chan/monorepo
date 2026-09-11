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
sorts entries alphabetically by `directory`, and requires the
`dependabot-auto-process` label on every entry.

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

例外として、Dependabot を意図的に有効にした実験プロジェクトがある。現在は `_labs/pi-agent-gui` だけが該当し、`scripts/maintain-dependabot.py` の `LAB_PROJECTS` で管理する。実験プロジェクトを対象に加える・外すときは、`.github/dependabot.yml` と `LAB_PROJECTS` の両方を同じ PR で更新する。

## Ecosystem Detection

Use lockfiles only:

| Lockfile | Ecosystem |
|----------|-----------|
| `bun.lock` or `bun.lockb` | `bun` |
| `pnpm-lock.yaml` | `npm` |
| `uv.lock` | `uv` |

> **pnpm に関する注記:** Dependabot には pnpm 専用の `package-ecosystem` 値がないため、`package-ecosystem: "npm"` を使用する。公式リファレンスでは pnpm v7〜v10 が version updates と security updates の両方に対応している（2026-09-12 時点。出典: GitHub 公式 docs "Dependabot supported ecosystems and repositories" の pnpm 行）。pnpm プロジェクトを `projects/` に追加したときは、この skill の通常フローに従い `.github/dependabot.yml` に `package-ecosystem: "npm"` のエントリを追加する。

## Step Details

### Step 1: Check for Uncommitted Changes

Before editing, run:

    git status --porcelain -- .github/dependabot.yml

If the output is non-empty, stop and warn the user. This catches both staged and unstaged changes.

### Step 2: Scan Projects

List candidate directories:

    labs_projects="pi-agent-gui"
    for dir in projects/*/; do
      name=$(basename "$dir")
      if [[ "$name" == "_labs" || "$name" == "_samples" ]]; then
        # 実験プロジェクトは既定では対象外。allowlist に入れたものだけを拾う。
        for lab in $labs_projects; do
          [[ -f "$dir$lab/pnpm-lock.yaml" ]] && echo "npm /projects/$name/$lab"
        done
        continue
      fi
      if [[ -f "$dir/bun.lock" || -f "$dir/bun.lockb" ]]; then
        echo "bun /projects/$name"
      elif [[ -f "$dir/pnpm-lock.yaml" ]]; then
        echo "npm /projects/$name"
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
      labels:
        - "dependabot-auto-process"
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

Add `dependabot-auto-process` to `labels` when it is absent, preserving any
existing labels and custom fields. Only normalize the group name to
`{name}-minor-and-patch` if it differs.

### Step 5: Diff and Propose

Compare desired entries with the current file. Show the diff and wait for user approval.
Do not write the file if the user does not explicitly approve.

### Step 6: Write and Validate

After approval, write `.github/dependabot.yml`. Then run:

    python3 -c "import yaml; yaml.safe_load(open('.github/dependabot.yml'))"

Finally, rerun the scan from Step 2 and confirm every detected project has exactly one entry.

Coverage validation must also confirm that every entry contains
`dependabot-auto-process`; a missing label is a validation error.

Run the skill tests with:

    python3 -m unittest discover -s .agents/skills/github-dependabot-maintain/tests -p 'test_*.py'

## Quality Check

- [ ] No uncommitted changes existed before editing
- [ ] Only `projects/` immediate subdirectories were scanned
- [ ] `_labs/` and `_samples/` were excluded except the `LAB_PROJECTS` allowlist
- [ ] Ecosystems were detected from lockfiles
- [ ] Existing entry settings were preserved except group names
- [ ] `dependabot-auto-process` is present on every generated and existing entry
- [ ] Entries are sorted alphabetically by `directory`
- [ ] User approved the diff before writing
- [ ] YAML syntax passes `python3 -c "import yaml; yaml.safe_load(...)"`
- [ ] Scan results and entries are 1:1 after writing
- [ ] Coverage validation detects a missing required label

## References

- `.github/dependabot.yml` - the file this skill maintains
- `references/github-dependabot-maintain-detailed.md` - detailed scanning and approval script
