#!/bin/bash

set -e

EVENT_NAME="$1"
REF_INPUT="$2"

if [[ "$EVENT_NAME" == "workflow_dispatch" ]]; then
  SHORT_SHA="$(git rev-parse --short HEAD)"
  SANITIZED_REF="$(printf '%s' "$REF_INPUT" | tr '[:upper:]' '[:lower:]' | sed -E 's#[^a-z0-9._-]+#-#g; s#-+#-#g; s#(^[-.]+|[-.]+$)##g')"

  if [[ -z "$SANITIZED_REF" ]]; then
    echo "Error: failed to sanitize ref input '$REF_INPUT'"
    exit 1
  fi

  IMAGE_TAG="manual-${SANITIZED_REF}-${SHORT_SHA}"
else
  IMAGE_TAG="latest"
fi

echo "Using image tag: $IMAGE_TAG"
echo "image_tag=$IMAGE_TAG"

if [[ -n "$GITHUB_OUTPUT" ]]; then
  echo "image_tag=$IMAGE_TAG" >> "$GITHUB_OUTPUT"
fi
