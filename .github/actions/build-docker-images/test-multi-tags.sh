#!/bin/bash

# build-docker-images のタグ付けテスト
# What: スペース区切りの複数タグを1回の docker build に -t で渡し、
#       COMMIT_HASH と --target を維持することを検証する

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/build-docker-images.sh"

PASS=0
FAIL=0

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1"
  local expected="$2"
  local file="$3"
  if grep -qF -- "$expected" "$file"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (not found: $expected)"
    echo "    log: $(cat "$file")"
    FAIL=$((FAIL + 1))
  fi
}

WORK_DIR="$(mktemp -d)"
cleanup() {
  [[ "${BASH_SUBSHELL:-0}" -eq 0 ]] || return 0
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Docker を実行せず、渡された引数を記録するフェイクを用意する
mkdir -p "$WORK_DIR/bin" "$WORK_DIR/projects/example"
cat > "$WORK_DIR/bin/docker" << 'EOF'
#!/bin/bash
echo "docker $*" >> "$DOCKER_LOG"
EOF
chmod +x "$WORK_DIR/bin/docker"

cat > "$WORK_DIR/projects/example/Dockerfile" << 'EOF'
FROM scratch AS test
FROM scratch AS final
EOF

cd "$WORK_DIR"
git init -q -b main .
git config user.email "test@example.com"
git config user.name "test"
git add -A
git commit -q -m base

echo "projects/example" > build_projects.txt

export DOCKER_LOG="$WORK_DIR/docker.log"
export GITHUB_REPOSITORY="owner/repo"
export PATH="$WORK_DIR/bin:$PATH"

echo "=== 複数タグのビルドテスト ==="

bash "$SCRIPT" "final" "latest sha-abc1234" > "$WORK_DIR/script.log" 2>&1

assert_eq "docker build の呼び出し回数" "1" "$(grep -c '^docker build' "$DOCKER_LOG")"
assert_eq "-t の数" "2" "$(grep -o -- '-t ' "$DOCKER_LOG" | wc -l | tr -d ' ')"
assert_contains "latest タグを付与する" "-t ghcr.io/owner/repo/example:latest" "$DOCKER_LOG"
assert_contains "SHA タグを付与する" "-t ghcr.io/owner/repo/example:sha-abc1234" "$DOCKER_LOG"
assert_contains "COMMIT_HASH を渡す" "--build-arg COMMIT_HASH=" "$DOCKER_LOG"
assert_contains "final ステージを対象にする" "--target=final" "$DOCKER_LOG"

echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
