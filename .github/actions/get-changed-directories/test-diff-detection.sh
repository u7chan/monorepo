#!/bin/bash

# 変更検出のテスト
# What: 一時 git リポジトリで push の before〜after 差分、リネーム、ref 解決失敗、
#       プルリクエスト経路、引数省略時の既定の比較を検証する

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/get-changed-dirs.sh"

PASS=0
FAIL=0
last_rc=0

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

assert_failure() {
  local label="$1"
  if [[ "$last_rc" -ne 0 ]]; then
    echo "  PASS: $label (exit=$last_rc)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (expected non-zero exit, got 0)"
    FAIL=$((FAIL + 1))
  fi
}

WORK_DIR="$(mktemp -d)"
cleanup() {
  [[ "${BASH_SUBSHELL:-0}" -eq 0 ]] || return 0
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

cd "$WORK_DIR"
git init -q -b main .
git config user.email "test@example.com"
git config user.name "test"
# スクリプトが生成する changed_dirs.txt をコミット対象に含めない
echo "changed_dirs.txt" >> .git/info/exclude

commit() {
  git add -A
  git commit -q -m "$1"
  git rev-parse HEAD
}

mkdir -p projects/a projects/b projects/old projects/d/src
touch projects/a/package.json projects/b/package.json
touch projects/old/package.json projects/d/package.json projects/d/src/main.ts
c0="$(commit base)"

echo a > projects/a/package.json
c1="$(commit "change a")"
echo b > projects/b/package.json
c2="$(commit "change b")"

mkdir -p projects/c
touch projects/c/package.json projects/c/Dockerfile
echo c > projects/c/package.json
c3="$(commit "add c")"

git mv projects/old projects/new
c4="$(commit "rename old to new")"

mkdir -p projects/d/lib
git mv projects/d/src/main.ts projects/d/lib/main.ts
c5="$(commit "move file in d")"

mkdir -p docs
echo note > docs/note.md
c6="$(commit "update docs")"

# 検出結果を比較しやすい形（カンマ区切り）で返す
detected() {
  paste -sd, - < "$WORK_DIR/changed_dirs.txt"
}

run_detection() {
  last_rc=0
  # CI（pull_request）は GITHUB_BASE_REF を全ステップに設定するため、
  # 引数省略時の既定（HEAD~1）を検証するには明示的に外す
  ( cd "$WORK_DIR" && env -u GITHUB_BASE_REF bash "$SCRIPT" "$@" ) > "$WORK_DIR/script.log" 2>&1 || last_rc=$?
}

run_pr_detection() {
  last_rc=0
  ( cd "$WORK_DIR" && GITHUB_BASE_REF=main bash "$SCRIPT" ) > "$WORK_DIR/script.log" 2>&1 || last_rc=$?
}

echo "=== 変更検出テスト ==="

echo "[Test 1] 複数コミットを含む push"
run_detection "$c2" "$c0"
assert_eq "before〜after の全コミットから検出する" "projects/a,projects/b" "$(detected)"

echo "[Test 2] 直前のコミットだけを変更する push"
run_detection "$c3" "$c2"
assert_eq "単一コミットの push を検出する" "projects/c" "$(detected)"

echo "[Test 3] プロジェクトのリネーム"
run_detection "$c4" "$c3"
assert_eq "リネーム後（新しいパス）のプロジェクトを検出する" "projects/new" "$(detected)"

echo "[Test 4] プロジェクト内のファイル移動"
run_detection "$c5" "$c4"
assert_eq "プロジェクト内の移動でプロジェクトを検出する" "projects/d" "$(detected)"

echo "[Test 5] projects 配下に変更がない push"
run_detection "$c6" "$c5"
assert_eq "対象外の変更では空になる" "" "$(detected)"

echo "[Test 6] 解決できない ref"
run_detection "$c6" "0000000000000000000000000000000000000000"
assert_failure "解決できない ref では失敗する"

echo "[Test 7] プルリクエスト経路（GITHUB_BASE_REF）"
git update-ref refs/remotes/origin/main "$c2"
run_pr_detection
assert_eq "ベースブランチとの差分で検出する" "projects/c,projects/d,projects/new" "$(detected)"

echo "[Test 8] 引数省略（HEAD と HEAD~1）"
run_detection
assert_eq "引数省略時は HEAD と HEAD~1 を比較する" "" "$(detected)"

echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
