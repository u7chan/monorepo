#!/bin/bash

set -e

PROJECTS_INPUT="$1"
STAGE_INPUT="$2"

if [[ -z "$PROJECTS_INPUT" ]]; then
  echo "Error: projects input is required."
  exit 1
fi

if [[ -z "$STAGE_INPUT" ]]; then
  echo "Error: stage input is required."
  exit 1
fi

: > build_projects.txt
IFS=',' read -ra PROJECT_ARRAY <<< "$PROJECTS_INPUT"
for project in "${PROJECT_ARRAY[@]}"; do
  project="$(echo "$project" | xargs)"
  [[ -z "$project" ]] && continue

  if [[ ! -f "$project/Dockerfile" ]]; then
    echo "Error: Dockerfile not found at $project/Dockerfile"
    exit 1
  fi

  if ! grep -qE "AS\\s+$STAGE_INPUT" "$project/Dockerfile"; then
    echo "Error: Stage '$STAGE_INPUT' not found in $project/Dockerfile"
    exit 1
  fi

  echo "$project" >> build_projects.txt
done

if [[ ! -s build_projects.txt ]]; then
  echo "Error: no valid projects were provided."
  exit 1
fi

if [[ -n "$GITHUB_ENV" ]]; then
  echo "BUILD_PROJECT=$(paste -sd, build_projects.txt)" >> "$GITHUB_ENV"
fi
