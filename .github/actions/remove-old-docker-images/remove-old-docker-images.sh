#!/bin/bash

# Docker イメージの古いバージョンを削除する
# 最新 N 個のタグ付きイメージを残し、それ以外を削除する

set -e

KEEP_COUNT=${1:-3}

echo "=== Removing old Docker images (keeping latest $KEEP_COUNT) ==="

# build_projects.txt が存在するかチェック
if [[ ! -f "build_projects.txt" ]]; then
    echo "build_projects.txt not found. Skipping cleanup."
    exit 0
fi

# 各プロジェクトについて古いイメージを削除
while IFS= read -r project || [[ -n "$project" ]]; do
    if [[ -n "$project" && ! "$project" =~ ^[[:space:]]*$ ]]; then
        project_name=$(basename "$project")
        echo "Processing project: $project_name"
        
        # プロジェクト名を含むイメージを取得（タグ付きのもののみ）
        images=$(docker images --format "{{.Repository}}:{{.Tag}}	{{.CreatedAt}}" | \
                grep "$project_name" | \
                grep -v "<none>" | \
                sort -k2 -r | \
                tail -n +$((KEEP_COUNT + 1)) | \
                awk '{print $1}' || true)
        
        if [[ -n "$images" ]]; then
            echo "Removing old images for $project_name:"
            echo "$images"
            
            # モックモードでない場合のみ実際に削除
            if [[ "$MOCK_DOCKER_COMMANDS" != "true" ]]; then
                echo "$images" | xargs -r docker rmi || true
            else
                echo "[MOCK] Would remove: $images"
            fi
        else
            echo "No old images to remove for $project_name"
        fi
        
        echo ""
    fi
done < build_projects.txt

echo "Docker image cleanup completed."
