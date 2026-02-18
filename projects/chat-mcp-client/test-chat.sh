#!/bin/bash

set -e

API_URL="${API_URL:-http://localhost:3000}"
MODEL="${MODEL:-gpt-4o-mini}"

curl -N "${API_URL}/api/chat/completions" \
  -H "Content-Type: application/json" \
  -H "mcp-server-urls: " \
  -d "{
    \"model\": \"${MODEL}\",
    \"messages\": [
      {\"role\": \"system\", \"content\": \"You are a helpful assistant.\"},
      {\"role\": \"user\", \"content\": \"Hello!\"}
    ],
    \"temperature\": 0.7,
    \"maxTokens\": 100
  }"
