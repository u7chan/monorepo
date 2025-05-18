#!/bin/sh

# このシェルスクリプトは、CI/CDのDockerビルド前に実行されます。
# Node.jsプロジェクト内の`package.json`から依存関係として指定されている`workspace:`を使用したライブラリを抽出し、
# それらをプロジェクト配下の`packages`ディレクトリにコピーして、`package.json`の依存関係を修正します。
# これにより、Dockerビルド時に必要なライブラリが正しく参照されるようになります。
#
# 注意:
#   このスクリプトを実行するにはNode.jsが動作する環境が必要です。
#   検証時に一度ローカルで動かすと`package.json`の内容が変わるので、`package.json`変更はコミットしないでください。

set -ea

# package.jsonの依存関係から workspace: を含むライブラリを抽出
WORKSPACE_LIBS=$(node -p "Object.entries(require('./package.json').dependencies || {}).filter(([_, value]) => value.startsWith('workspace:')).map(([_, value]) => value.replace('workspace:', '')).join(' ')")
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

# 文字列をスペースで分割し、配列に格納
read -r -a WORKSPACE_LIBS_ARRAY <<< "$WORKSPACE_LIBS"

for path in "${WORKSPACE_LIBS_ARRAY[@]}"; do
    echo "Processing workspace library path: $path"
    package_dir_name=$(basename "$path")
    echo "Package directory name: $package_dir_name"

    # cpで現在のディレクトリにライブラリをコピー
    cp -r "$path" "./packages"

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
