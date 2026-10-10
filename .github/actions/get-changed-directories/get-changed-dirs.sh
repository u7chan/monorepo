#!/bin/bash

# 変更されたディレクトリを取得するスクリプト
# GitHub Actionとローカルテストの両方で使用
#
# 使用方法:
#   ./get-changed-dirs.sh [新しい側のref] [古い側のref]
#
# 引数を省略した場合は、PR（GITHUB_BASE_REF）または直前のコミットと比較する。

set -euo pipefail

# 新しい側の ref と古い側の ref を明示できる。push イベントでは before〜after を渡し、
# checkout が最新 main でも push の差分だけを検出できるようにする。
NEW_REF="${1:-HEAD}"
OLD_REF="${2:-}"

if [[ -z "$OLD_REF" ]]; then
  if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
    # プルリクエストの場合、ベースブランチとの比較
    OLD_REF="refs/remotes/origin/$GITHUB_BASE_REF"
  else
    # プッシュイベントの場合、前のコミットとの比較
    OLD_REF="HEAD~1"
  fi
fi

# 対象ディレクトリを定義
TARGET_DIRS=("projects")

# プロジェクトルート判定用のマーカーファイル
PROJECT_MARKERS=(
  "package.json"
  "pyproject.toml"
  "Dockerfile"
  "go.mod"
  "Cargo.toml"
  "Makefile"
  "docker-compose.yaml"
  "docker-compose.yml"
)

# 比較対象を解決できないまま進めると、差分なしとして成功扱いになり、
# ビルド対象が黙って 0 件になる。検出漏れを成功として扱わないためここで落とす。
require_commit() {
  local ref="$1"
  if ! git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    echo "Error: cannot resolve '$ref' as a commit." >&2
    echo "Hint: fetch enough history to compare $NEW_REF and $OLD_REF." >&2
    exit 1
  fi
}

require_commit "$NEW_REF"
require_commit "$OLD_REF"

# 関数: diff_with_renames
# 引数:
#   $1 - 比較したい最初のリファレンス（新しい側）
#   $2 - 比較したい2番目のリファレンス（古い側）
# 機能:
#   2つのリファレンス間の差分で、リネーム（移動）されたファイルの
#   移動後のパスと、それ以外の変更ファイルを区別して出力します。
diff_with_renames() {
  # 第1引数に新しい側を固定する。逆順にすると name-status の2列目が移動前のパスになり、
  # ビルド対象の作業ツリーに存在しないディレクトリをプロジェクトルートとして探索してしまう。
  { git diff --diff-filter=R --name-status "$1" "$2"; } | awk '$1 ~ /^R/ {print $2}'
  git diff --diff-filter=ACMTUXBD --name-only "$1" "$2"
}

is_project_root_dir() {
  local dir="$1"
  [[ "$dir" == projects/* && "$dir" != */*/* ]] && return 0
  [[ "$dir" == projects/_labs/* && "$dir" != projects/_labs/*/* ]] && return 0
  [[ "$dir" == projects/poc/* && "$dir" != projects/poc/*/* ]] && return 0
  [[ "$dir" == projects/_samples/* && "$dir" != projects/_samples/*/* ]] && return 0
  return 1
}

# 関数: find_project_root
# 引数:
#   $1 - 変更ファイルのパス
# 機能:
#   ファイルの親ディレクトリから上方へ辿り、プロジェクトルートを探索する。
#   projects/<name> 直下のマーカーが存在する場合はそれを優先する。
#   それ以外の場合は最寄りのマーカーを含むディレクトリを返す。
find_project_root() {
  local file="$1"
  local dir
  dir="$(dirname "$file")"
  local first_found=""

  while [[ "$dir" != "." && "$dir" != "/" && "$dir" != "" ]]; do
    for marker in "${PROJECT_MARKERS[@]}"; do
      if [[ -f "$dir/$marker" ]]; then
        if [[ -z "$first_found" ]]; then
          first_found="$dir"
        fi
        # project root 直下のマーカーを優先
        if is_project_root_dir "$dir"; then
          echo "$dir"
          return 0
        fi
      fi
    done
    dir="$(dirname "$dir")"
  done

  if [[ -n "$first_found" ]]; then
    echo "$first_found"
  fi
}

# 差分は一度だけ取得する。比較に失敗した場合に変更 0 件として扱わないよう、
# ここで失敗を検知して異常終了させる。
diff_output="$(mktemp)"
trap 'rm -f "$diff_output"' EXIT

diff_with_renames "$NEW_REF" "$OLD_REF" > "$diff_output"

echo "> diff $(git rev-parse --short "$NEW_REF") ($NEW_REF) -> $(git rev-parse --short "$OLD_REF") ($OLD_REF)"
cat "$diff_output"
echo ""

# 変更ファイルからプロジェクトルートを探索
{
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    for target_dir in "${TARGET_DIRS[@]}"; do
      prefix="$target_dir/"
      if [[ "$file" == "$prefix"* ]]; then
        find_project_root "$file"
        break
      fi
    done
  done < "$diff_output"
} | sort -u > changed_dirs.txt

echo "> changes"
cat changed_dirs.txt
echo ""
