#!/usr/bin/env bash
# ペアリングの一時コードを発行し、端末へ QR として描画する。
#
# 発行 API は loopback からのリクエストだけを受け付けるため、WSL2 内から実行する（docs/pairing.md を参照）。
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$SCRIPT_DIR/.."
readonly PORT="${PORT:-18081}"

# die / run_powershell / detect_windows_lan は lan-access.sh と共有する。
source "$SCRIPT_DIR/windows-lan.sh"

usage() {
  cat <<'USAGE'
使い方: pnpm pair

サーバー（既定: http://127.0.0.1:18081）から一時コードを発行し、URL を QR として端末に描画する。
サーバーは pnpm start（または pnpm dev）で起動しておく。PORT を変えている場合は同じ値を渡す。

  PORT=3100 pnpm pair

QR を開く URL のホストは Windows の LAN IP を自動検出して使う。検出できない場合は WSL2 上で実行しているか確認する。
USAGE
}

detect_windows_ip() {
  local output windows_ip

  for command in powershell.exe iconv base64 awk; do
    command -v "$command" >/dev/null 2>&1 ||
      die "$command が見つかりません。Windows の LAN IP の検出には WSL2 上での実行が必要です。"
  done

  if ! output="$(run_powershell "$(detect_windows_lan "")")"; then
    printf '%s\n' "$output" >&2
    die "Windows 側の LAN IP を特定できませんでした。"
  fi

  windows_ip="$(printf '%s\n' "$output" | awk -F= '$1 == "WINDOWS_IP" { print $2; exit }')"

  [[ -n "$windows_ip" ]] || die "Windows 側の LAN IP を特定できませんでした。"

  printf '%s\n' "$windows_ip"
}

request_pair_code() {
  local origin="$1"
  local response status body

  if ! response="$(curl -sS -X POST -H 'content-type: application/json' \
    --data "$(printf '{"origin":"%s"}' "$origin")" -w '\n%{http_code}' \
    "http://127.0.0.1:${PORT}/api/pair/new" 2>&1)"; then
    die "サーバーに接続できません（http://127.0.0.1:${PORT}）。pnpm start で起動してから実行してください: $response"
  fi

  status="${response##*$'\n'}"
  body="${response%$'\n'*}"

  if [[ "$status" != "200" ]]; then
    die "一時コードを発行できませんでした（HTTP $status）: $body"
  fi

  printf '%s\n' "$body"
}

main() {
  case "${1:-}" in
    "") ;;
    -h | --help)
      usage
      return 0
      ;;
    *)
      usage >&2
      die "不明な引数: $1"
      ;;
  esac

  command -v curl >/dev/null 2>&1 || die "curl が見つかりません。"

  [[ -f "$PROJECT_DIR/node_modules/tsx/package.json" ]] ||
    die "node_modules/tsx が見つかりません。先に pnpm install を実行してください。"

  local windows_ip origin body

  windows_ip="$(detect_windows_ip)"
  origin="http://${windows_ip}:${PORT}"
  body="$(request_pair_code "$origin")"

  printf '%s' "$body" | node --import tsx "$SCRIPT_DIR/print-qr.ts"
}

main "$@"
