#!/bin/sh

set -ea

# package.jsonの依存関係から workspace: を含むライブラリを抽出
WORKSPACE_LIBS=$(node -p "Object.entries(require('./package.json').dependencies || {}).filter(([_, value]) => value.startsWith('workspace:')).map(([_, value]) => value.replace('workspace:', ''))")
echo "Extracted workspace libraries: $WORKSPACE_LIBS"

# ワークスペースライブラリがない場合は終了
if [ -z "$WORKSPACE_LIBS" ]; then
    echo "No workspace libraries found"
    exit 1
fi

# 現在のスクリプトの絶対パスを取得
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# packagesディレクトリを作成
mkdir -p "./packages"

# 抽出したライブラリをループ処理
echo "$WORKSPACE_LIBS" | sed -e 's/^\[//; s/\]$//; s/,//g; s/"//g; s/'"'"'//g' | while read -r WORKSPACE_PATH; do
    echo "Processing workspace library: $WORKSPACE_PATH"
    path=$WORKSPACE_PATH
    package_dir_name=$(basename "$path")
    echo "Package directory name: $package_dir_name"

    # cpで現在のディレクトリにライブラリをコピー
    cp -r "$WORKSPACE_PATH" "./packages"

    # package.jsonの置換処理
    ## TODO: package.jsonのdependenciesを修正（以下のように置換したい）
    ## before: "{package_dir_name}": "workspace:../../{package_dir_name}"
    ## after: "{package_dir_name}": "workspace:{package_dir_name}"
done

echo "All workspace libraries processed successfully 🚀"
