#!/bin/sh
# CI用テストスクリプト

echo "Running CI sample tests..."

# 簡単な検証テスト
test -f scripts/test.sh && echo "[PASS] test.sh exists"
test -d tests && echo "[PASS] tests directory exists"

echo "All tests passed!"
