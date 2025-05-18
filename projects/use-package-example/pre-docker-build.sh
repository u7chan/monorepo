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

    # package.jsonのdependenciesを修正
    node -e "
    const fs = require('fs');
    const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
    for (const [dep, version] of Object.entries(packageJson.dependencies || {})) {
        if (version.startsWith('workspace:')) {
            const newPath = version.replace(/workspace:.*\//, 'workspace:packages/');
            packageJson.dependencies[dep] = newPath;
        }
    }
    fs.writeFileSync('./package.json', JSON.stringify(packageJson, null, 2));
    "
done

echo "All workspace libraries processed successfully 🚀"
