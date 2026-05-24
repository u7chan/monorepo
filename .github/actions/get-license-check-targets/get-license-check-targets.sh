#!/bin/bash

set -euo pipefail

MANIFEST_FILES=(
  "package.json"
  "bun.lock"
  "bun.lockb"
  "package-lock.json"
  "pyproject.toml"
  "uv.lock"
)

MECHANISM_PATTERNS=(
  "scripts/check-licenses"
  "scripts/check_licenses.py"
  "scripts/license-policy.json"
  "scripts/tests/test_check_licenses.py"
  ".github/actions/get-license-check-targets/"
  ".github/workflows/pullrequest-check.yml"
)

if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
  BASE_REF="refs/remotes/origin/$GITHUB_BASE_REF"
else
  BASE_REF="HEAD~1"
fi

diff_with_renames() {
  git diff --name-only "$1" "$2" || true
}

is_manifest_file() {
  local path="$1"
  local basename
  basename="$(basename "$path")"
  for manifest in "${MANIFEST_FILES[@]}"; do
    if [[ "$basename" == "$manifest" ]]; then
      return 0
    fi
  done
  return 1
}

manifest_target() {
  local path="$1"
  local dir
  dir="$(dirname "$path")"
  if [[ "$dir" == "." ]]; then
    return 1
  fi
  if [[ -f "$dir/package.json" || -f "$dir/pyproject.toml" ]]; then
    echo "$dir"
    return 0
  fi
  return 1
}

matches_mechanism_pattern() {
  local path="$1"
  for pattern in "${MECHANISM_PATTERNS[@]}"; do
    if [[ "$pattern" == */ ]]; then
      if [[ "$path" == "$pattern"* ]]; then
        return 0
      fi
    elif [[ "$path" == "$pattern" ]]; then
      return 0
    fi
  done
  return 1
}

echo "> diff with $BASE_REF"
changed_files="$(diff_with_renames HEAD "$BASE_REF")"
printf '%s\n' "$changed_files"
echo ""

targets_tmp="$(mktemp)"
validation_required="false"

while IFS= read -r changed_file; do
  [[ -z "$changed_file" ]] && continue

  if matches_mechanism_pattern "$changed_file"; then
    validation_required="true"
  fi

  if [[ "$changed_file" != projects/* ]]; then
    continue
  fi

  if is_manifest_file "$changed_file"; then
    manifest_target "$changed_file" >> "$targets_tmp" || true
  fi
done <<< "$changed_files"

sort -u "$targets_tmp" > license_check_targets.txt
rm -f "$targets_tmp"

license_check_targets="$(paste -sd, license_check_targets.txt)"

echo "> license check targets"
cat license_check_targets.txt
echo ""
echo "LICENSE_CHECK_TARGETS: $license_check_targets"
echo "LICENSE_CHECK_VALIDATION_REQUIRED: $validation_required"

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "LICENSE_CHECK_TARGETS=$license_check_targets" >> "$GITHUB_ENV"
  echo "LICENSE_CHECK_VALIDATION_REQUIRED=$validation_required" >> "$GITHUB_ENV"
fi
