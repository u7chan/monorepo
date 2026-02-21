#!/bin/bash
set -e

WORKSPACE_DIR="/workspaces/monorepo/projects/portfolio"
NODE_MODULES_DIR="$WORKSPACE_DIR/node_modules"

safe-chain --version

# named volumeで作成されるnode_modulesを事前に作成し、権限をremoteUserに変更
sudo mkdir -p "$NODE_MODULES_DIR"
sudo chown -R "$(id -un):$(id -gn)" "$WORKSPACE_DIR"

bun i
[ -e .env ] || cp .env.example .env
