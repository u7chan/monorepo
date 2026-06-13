# Detailed Scanning and Approval Script

## Full maintenance script

A Bash script you can adapt to preview changes before writing:

```bash
#!/usr/bin/env bash
set -euo pipefail

CONFIG=".github/dependabot.yml"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# 1. Safety check
if [ -n "$(git diff -- "$CONFIG")" ]; then
  echo "ERROR: $CONFIG has uncommitted changes. Commit or revert them first."
  exit 1
fi

# 2. Scan projects and detect ecosystems
pairs=()
for dir in projects/*/; do
  name=$(basename "$dir")
  [[ "$name" == "_labs" || "$name" == "_samples" ]] && continue

  eco=""
  if [[ -f "$dir/bun.lock" || -f "$dir/bun.lockb" ]]; then
    eco="bun"
  elif [[ -f "$dir/uv.lock" ]]; then
    eco="uv"
  fi

  if [ -n "$eco" ]; then
    pairs+=("$name $eco")
  fi
done

# 3. Generate desired config
{
  echo "version: 2"
  echo "updates:"

  # Sort by project name for deterministic output
  first=true
  printf '%s\n' "${pairs[@]}" | sort | while read -r name eco; do
    if [ "$first" = true ]; then
      first=false
    else
      echo ""  # blank line between entries, matching current format
    fi
    cat << ENTRY
  - package-ecosystem: "$eco"
    directory: "/projects/$name"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 1
    rebase-strategy: "disabled"
    groups:
      $name-minor-and-patch:
        applies-to: version-updates
        patterns:
          - "*"
        update-types:
          - "minor"
          - "patch"
ENTRY
  done
} > "$TMP_DIR/desired.yml"

# 4. Show diff and stop for approval
diff -u "$CONFIG" "$TMP_DIR/desired.yml" || true

# Do not write the config here. Wait for explicit user approval.
# After approval, run:
#   cp "$TMP_DIR/desired.yml" "$CONFIG"
#   python3 -c "import yaml; yaml.safe_load(open('$CONFIG'))"
```

## After approval

Write the file and validate:

```bash
cp "$TMP_DIR/desired.yml" "$CONFIG"
python3 -c "import yaml; yaml.safe_load(open('$CONFIG'))"
```

Recheck coverage by rerunning the scan and confirming each detected project has one entry.

## Edge cases

- If a project has both `bun.lock` and `uv.lock`, treat that as an error and ask the user.
- If no lockfile is found, exclude the directory from Dependabot.
- If an existing entry points to a directory that no longer exists, remove it.
- If an existing entry points to a directory whose lockfile is gone, remove it.
