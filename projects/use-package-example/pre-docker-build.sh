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

# 抽出したライブラリをループ処理
echo "$WORKSPACE_LIBS" | sed -e 's/^\[//; s/\]$//; s/,//g; s/"//g; s/'"'"'//g' | while read -r WORKSPACE_PATH; do
    echo "Processing workspace library: $WORKSPACE_PATH"

    # cpで現在のディレクトリにライブラリをコピー
    mkdir -p "./packages"
    cp -r "$WORKSPACE_PATH" "./packages"
done

echo "All workspace libraries processed successfully 🚀"
