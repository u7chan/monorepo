#!/bin/bash

set -euo pipefail

EVENT_NAME="${1:-}"
REF_INPUT="${2:-}"

if [[ -z "$EVENT_NAME" ]]; then
  echo "Error: event name is required." >&2
  exit 1
fi

# ビルド元は checkout 済みの HEAD。push イベントでも github.sha とは限らないため、
# 実際にビルドする commit からタグと記録用の SHA を作る。
SOURCE_SHA="$(git rev-parse HEAD)"
SHORT_SHA="$(git rev-parse --short HEAD)"

if [[ "$EVENT_NAME" == "workflow_dispatch" ]]; then
  SANITIZED_REF="$(printf '%s' "$REF_INPUT" | tr '[:upper:]' '[:lower:]' | sed -E 's#[^a-z0-9._-]+#-#g; s#-+#-#g; s#(^[-.]+|[-.]+$)##g')"

  if [[ -z "$SANITIZED_REF" ]]; then
    echo "Error: failed to sanitize ref input '$REF_INPUT'" >&2
    exit 1
  fi

  # 手動実行が latest を上書きしないよう、手動タグだけを付与する
  IMAGE_TAG="manual-${SANITIZED_REF}-${SHORT_SHA}"
  IMAGE_TAGS="$IMAGE_TAG"
else
  IMAGE_TAG="latest"
  IMAGE_TAGS="latest sha-${SHORT_SHA}"
fi

echo "Build source commit: $SOURCE_SHA"
echo "Using image tag: $IMAGE_TAG"
echo "Using image tags: $IMAGE_TAGS"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "image_tag=$IMAGE_TAG"
    echo "image_tags=$IMAGE_TAGS"
    echo "commit_sha=$SOURCE_SHA"
  } >> "$GITHUB_OUTPUT"
fi
