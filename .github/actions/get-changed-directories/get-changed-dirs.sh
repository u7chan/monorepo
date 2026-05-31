#!/bin/bash

# 変更されたディレクトリを取得するスクリプト
# GitHub Actionとローカルテストの両方で使用

set -e

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

# 関数: diff_with_renames
# 引数:
#   $1 - 比較したい最初のリファレンス（例: HEAD）
#   $2 - 比較したい2番目のリファレンス（例: origin/main）
# 機能:
#   2つのリファレンス間の差分で、リネーム（移動）されたファイルの
#   移動後のパスと、それ以外の変更ファイルを区別して出力します。
diff_with_renames() {
  # 比較順は HEAD -> BASE のため、name-status の2列目が現在のパスになる。
  { git diff --diff-filter=R --name-status "$1" "$2" || true; } | awk '$1 ~ /^R/ {print $2}'
  { git diff --diff-filter=ACMTUXBD --name-only "$1" "$2" || true; }
}

is_project_root_dir() {
  local dir="$1"
  [[ "$dir" == projects/* && "$dir" != */*/* ]] && return 0
  [[ "$dir" == projects/labs/* && "$dir" != projects/labs/*/* ]] && return 0
  [[ "$dir" == projects/poc/* && "$dir" != projects/poc/*/* ]] && return 0
  [[ "$dir" == projects/samples/* && "$dir" != projects/samples/*/* ]] && return 0
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

# GitHub Actions環境での比較対象を決定
if [ -n "$GITHUB_BASE_REF" ]; then
  # プルリクエストの場合、ベースブランチとの比較
  BASE_REF="refs/remotes/origin/$GITHUB_BASE_REF"
else
  # プッシュイベントの場合、前のコミットとの比較
  BASE_REF="HEAD~1"
fi

echo "> diff with $BASE_REF"
diff_with_renames HEAD "$BASE_REF"
echo ""

# 変更ファイルからプロジェクトルートを探索
{
  while IFS= read -r file; do
    for target_dir in "${TARGET_DIRS[@]}"; do
      prefix="$target_dir/"
      if [[ "$file" == "$prefix"* ]]; then
        find_project_root "$file"
        break
      fi
    done
  done < <(diff_with_renames HEAD "$BASE_REF")
} | sort -u > changed_dirs.txt

echo "> changes"
cat changed_dirs.txt
echo ""
