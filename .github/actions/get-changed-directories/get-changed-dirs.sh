#!/bin/bash

# 変更されたディレクトリを取得するスクリプト
# GitHub Actionとローカルテストの両方で使用

set -e

# 対象ディレクトリを定義
TARGET_DIRS=("projects", "packages")

# 関数: diff_with_renames
# 引数:
#   $1 - 比較したい最初のリファレンス（例: HEAD）
#   $2 - 比較したい2番目のリファレンス（例: origin/main）
# 機能:
#   2つのリファレンス間の差分で、リネーム（移動）されたファイルの
#   移動後のパスと、それ以外の変更ファイルを区別して出力します。
diff_with_renames() {
  # リネームされたファイルの移動後のパスを取得
  git diff --diff-filter=R --name-status $1 $2 | awk '$1 ~ /^R/ {print $2}'
  # その他の差分
  git diff --name-only $1 $2 | grep -vFf <(git diff --name-only --diff-filter=R $1 $2)
}

echo "> diff"
diff_with_renames HEAD origin/main
echo ""

# 対象ディレクトリの配列をAWKに渡すための文字列を作成
TARGET_DIRS_STR=$(printf "%s," "${TARGET_DIRS[@]}")
TARGET_DIRS_STR=${TARGET_DIRS_STR%,}  # 末尾のカンマを削除

# 最新のコミットととリモートのmainブランチの差分を取得
# 対象ディレクトリ配下のファイルのディレクトリ名を取得
diff_with_renames HEAD origin/main | \
awk -F/ -v target_dirs="$TARGET_DIRS_STR" '
  BEGIN {
    # 対象ディレクトリを動的に配列として定義
    split(target_dirs, dirs_array, ",")
    for (i in dirs_array) {
      dirs[dirs_array[i]] = 1
    }
  }
  $1 in dirs { print $1 "/" $2 }
' | \
# 重複を取り除く
sort -u > changed_dirs.txt

echo "> changes"
cat changed_dirs.txt
echo ""
