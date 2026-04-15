#!/bin/bash

set -euo pipefail

TOKEN="$1"
REPO_NAME="$2"
SOURCE_REPOSITORY="$3"
SOURCE_REF="$4"
SOURCE_SHA="$5"

if [[ -z "$TOKEN" ]]; then
  echo "Error: GitHub token is required."
  exit 1
fi

if [[ -z "$REPO_NAME" ]]; then
  echo "Error: Repository name is required."
  exit 1
fi

if [[ -z "$SOURCE_REPOSITORY" || -z "$SOURCE_REF" || -z "$SOURCE_SHA" ]]; then
  echo "Error: Source repository, ref, and SHA are required."
  exit 1
fi

PAYLOAD=$(printf '{"event_type":"sync_manual_deploy_targets","client_payload":{"source_repository":"%s","source_ref":"%s","source_sha":"%s"}}' \
  "$SOURCE_REPOSITORY" \
  "$SOURCE_REF" \
  "$SOURCE_SHA")

echo "Triggering manual deploy target sync"
echo "source_repository=$SOURCE_REPOSITORY"
echo "source_ref=$SOURCE_REF"
echo "source_sha=$SOURCE_SHA"

curl --fail-with-body -sS -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/u7chan/$REPO_NAME/dispatches" \
  -d "$PAYLOAD"

echo ""
echo "Manual deploy target sync trigger sent successfully."
