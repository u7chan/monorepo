#!/usr/bin/env bash
# Windows 側の portproxy とファイアウォール規則を、確認 / 追加 / 削除する。
#
# 昇格した PowerShell へ渡すスクリプトは、リポジトリ内の .ps1 を -File で読ませるのではなくコマンド文字列から組み立てる。
# 昇格プロセスから \\wsl.localhost\ の UNC パスは読めない（WSL の制約）ため、.ps1 を置いて管理者に実行させる経路は脆い。
# 入れ子の引用符を避けるため、PowerShell 側のスクリプトはすべて -EncodedCommand（UTF-16LE + base64）で渡す。
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$SCRIPT_DIR/.."
readonly TARGET_PORT=18081
readonly LISTEN_ADDRESS="0.0.0.0"
readonly RULE_NAME="18081(herdr-mobile-client)"
readonly EXISTING_RULE_NAME="3000(dev)"

# die / substitute / run_powershell / detect_windows_lan は pair.sh と共有する。
source "$SCRIPT_DIR/windows-lan.sh"

usage() {
  cat <<'USAGE'
使い方: scripts/lan-access.sh [オプション]

  （オプションなし）  現在の portproxy とファイアウォール規則を表示する（昇格しない）
  --add               18081 の portproxy とファイアウォール規則を追加する（UAC の承認が必要）
  --remove            18081 の portproxy とファイアウォール規則を削除する（UAC の承認が必要）
  --windows-ip IP     Windows 側の LAN IP（既定: 既定ルートのインターフェースから自動検出）
  -h, --help          この使い方を表示する

WSL2 の IP は既定ルートのインターフェースから自動検出する。LAN セグメント（プレフィックス長）は
Windows 側の IP を持つインターフェースから得る。
USAGE
}

validate_ipv4() {
  local octet='(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])'

  [[ "$1" =~ ^($octet\.){3}$octet$ ]] || die "IPv4 アドレスとして解釈できません: $1"
}

require_commands() {
  command -v powershell.exe >/dev/null 2>&1 ||
    die "powershell.exe が見つかりません。WSL2 から実行してください。"

  for command in ip awk iconv base64 wslpath; do
    command -v "$command" >/dev/null 2>&1 || die "$command が見つかりません。"
  done
}

windows_to_wsl_path() {
  wslpath -u "${1//\\//}"
}

detect_wsl_ip() {
  local device cidr

  device="$(ip -4 route show default | awk '{ for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit } }')"
  [[ -n "$device" ]] || die "既定ルートのインターフェースを特定できませんでした。"

  cidr="$(ip -4 -o addr show dev "$device" scope global | awk '{ print $4; exit }')"
  [[ -n "$cidr" ]] || die "インターフェース $device の IPv4 アドレスを特定できませんでした。"

  printf '%s\n' "${cidr%/*}"
}

confirm_script() {
  local script

  script="$(cat <<'SCRIPT'
$ProgressPreference = "SilentlyContinue"
$ErrorActionPreference = "Stop"

# WSL から起動した powershell.exe は [Console]::OutputEncoding が shift_jis のままで、
# ネイティブコマンド（netsh）の UTF-8 出力を取り違える。ログの文字化けを避けるために UTF-8 に揃える。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Output "== netsh interface portproxy show v4tov4 =="
netsh interface portproxy show v4tov4
Write-Output ""

foreach ($name in @("@@RULE_NAME@@", "@@EXISTING_RULE_NAME@@")) {
  Write-Output ("== firewall rule: " + $name + " ==")

  $rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Select-Object -First 1

  if ($null -eq $rule) {
    Write-Output "(not found)"
    Write-Output ""
    continue
  }

  $port = $rule | Get-NetFirewallPortFilter
  $address = $rule | Get-NetFirewallAddressFilter

  Write-Output ("enabled: " + $rule.Enabled + " / profile: " + $rule.Profile + " / direction: " + $rule.Direction + " / action: " + $rule.Action)
  Write-Output ("protocol: " + ($port.Protocol -join ",") + " / localport: " + ($port.LocalPort -join ","))
  Write-Output ("remoteaddress: " + ($address.RemoteAddress -join ","))
  Write-Output ""
}
SCRIPT
)"

  script="$(substitute "$script" "@@RULE_NAME@@" "$RULE_NAME")"

  substitute "$script" "@@EXISTING_RULE_NAME@@" "$EXISTING_RULE_NAME"
}

inner_script() {
  local action="$1"
  local wsl_ip="$2"
  local windows_ip="$3"
  local lan_segment="$4"
  local log_path="$5"
  local script

  script="$(cat <<'INNER'
$ProgressPreference = "SilentlyContinue"
$ErrorActionPreference = "Stop"

# WSL から起動した powershell.exe は [Console]::OutputEncoding が shift_jis のままで、
# ネイティブコマンド（netsh）の UTF-8 出力を取り違える。ログの文字化けを避けるために UTF-8 に揃える。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$action = "@@ACTION@@"
$logPath = "@@LOG_PATH@@"
$targetPort = @@TARGET_PORT@@
$listenAddress = "@@LISTEN_ADDRESS@@"
$wslIp = "@@WSL_IP@@"
$windowsIp = "@@WINDOWS_IP@@"
$lanSegment = "@@LAN_SEGMENT@@"
$ruleName = "@@RULE_NAME@@"
$lines = New-Object System.Collections.Generic.List[string]

function Add-Line([string]$message) {
  $lines.Add($message)
}

function Save-Log {
  [System.IO.File]::WriteAllText($logPath, ($lines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

# 実行結果は netsh の出力から読み直して検証する。終了コードだけでは待ち受けアドレスの取り違えに気づけない。
function Get-PortProxyEntry([int]$port) {
  foreach ($line in ((netsh interface portproxy show v4tov4 | Out-String) -split "`r?`n")) {
    $fields = @($line.Trim() -split "\s+")

    if ($fields.Count -eq 4 -and $fields[1] -eq "$port") {
      return $fields
    }
  }

  return $null
}

try {
  Add-Line ("action: " + $action + " / windows ip: " + $windowsIp + " / lan segment: " + $lanSegment)
  Add-Line ("== portproxy " + $listenAddress + ":" + $targetPort + " ==")

  if ($action -eq "add") {
    netsh interface portproxy delete v4tov4 listenport=$targetPort listenaddress=$listenAddress 2>$null | Out-Null

    $result = netsh interface portproxy add v4tov4 listenport=$targetPort listenaddress=$listenAddress connectport=$targetPort connectaddress=$wslIp 2>&1

    Add-Line ("netsh portproxy add exit code: " + $LASTEXITCODE)

    if ($LASTEXITCODE -ne 0) {
      throw ("netsh interface portproxy add failed: " + ($result -join " "))
    }

    $entry = Get-PortProxyEntry $targetPort

    if ($null -eq $entry -or $entry[2] -ne $wslIp) {
      throw ("portproxy verification failed: " + ($entry -join " "))
    }

    Add-Line ("portproxy: " + $listenAddress + ":" + $targetPort + " -> " + $wslIp + ":" + $targetPort)
  } else {
    netsh interface portproxy delete v4tov4 listenport=$targetPort listenaddress=$listenAddress 2>$null | Out-Null

    if ($null -ne (Get-PortProxyEntry $targetPort)) {
      throw ("portproxy " + $targetPort + " is still present")
    }
  }

  Add-Line ("== firewall rule " + $ruleName + " ==")

  if ($action -eq "add") {
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $targetPort -Profile Any -RemoteAddress $lanSegment | Out-Null

    $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

    if ($null -eq $rule) {
      throw ("firewall rule " + $ruleName + " was not created")
    }

    $remoteAddress = ($rule | Get-NetFirewallAddressFilter).RemoteAddress -join ","

    if ([string]::IsNullOrEmpty($remoteAddress)) {
      throw ("firewall rule " + $ruleName + " has no remote address")
    }

    Add-Line ("firewall rule: " + $ruleName + " / enabled " + $rule.Enabled + " / profile " + $rule.Profile + " / localport " + (($rule | Get-NetFirewallPortFilter).LocalPort -join ","))
    Add-Line ("remoteaddress: " + $remoteAddress)
  } else {
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

    if ($null -ne (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
      throw ("firewall rule " + $ruleName + " is still present")
    }
  }

  Add-Line "== after =="
  Add-Line ((netsh interface portproxy show v4tov4 | Out-String).TrimEnd())

  Add-Line "RESULT: ok"
  Save-Log
  exit 0
} catch {
  Add-Line ("RESULT: error: " + $_.Exception.Message)
  Save-Log
  exit 1
}
INNER
)"

  script="$(substitute "$script" "@@ACTION@@" "$action")"
  script="$(substitute "$script" "@@LOG_PATH@@" "$log_path")"
  script="$(substitute "$script" "@@TARGET_PORT@@" "$TARGET_PORT")"
  script="$(substitute "$script" "@@LISTEN_ADDRESS@@" "$LISTEN_ADDRESS")"
  script="$(substitute "$script" "@@WSL_IP@@" "$wsl_ip")"
  script="$(substitute "$script" "@@WINDOWS_IP@@" "$windows_ip")"
  script="$(substitute "$script" "@@LAN_SEGMENT@@" "$lan_segment")"

  substitute "$script" "@@RULE_NAME@@" "$RULE_NAME"
}

elevation_script() {
  local inner="$1"
  local script

  script="$(cat <<'OUTER'
$ProgressPreference = "SilentlyContinue"
$ErrorActionPreference = "Stop"

$inner = @'
@@INNER@@
'@

$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))

# 昇格したウィンドウはすぐ閉じて出力を読めないため、結果は一時ファイル経由で受け取る。
# UAC が拒否された場合は Start-Process が例外を投げるので、握りつぶさず終了コード 1 で返す。
try {
  $process = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @("-NoProfile", "-EncodedCommand", $encoded)
  exit $process.ExitCode
} catch {
  Write-Output ("ERROR: " + $_.Exception.Message)
  exit 1
}
OUTER
)"

  substitute "$script" "@@INNER@@" "$inner"
}

run_cidr_check() {
  local expected="$1"
  local actual="$2"

  (cd "$PROJECT_DIR" && node --import tsx scripts/cidr-cli.ts "$expected" "$actual")
}

require_verification_tools() {
  command -v node >/dev/null 2>&1 ||
    die "node が見つかりません。--add は読み戻した RemoteAddress の検証に node を使います。"

  [[ -f "$PROJECT_DIR/node_modules/tsx/package.json" ]] ||
    die "node_modules/tsx が見つかりません。--add の前に pnpm install を実行してください。"
}

# 規則の RemoteAddress は、設定した表記では返らない（192.0.2.0/24 は 192.0.2.0/255.255.255.0 で返る）。
# 表記の差を吸収する正規化は scripts/cidr.ts にだけ置く。PowerShell 側にも同じ計算を置くと二重実装になり、
# node --test（test/cidr.test.ts）で確認できなくなる。
verify_remote_address() {
  local log_path="$1"
  local expected="$2"
  local actual result

  actual="$(awk '/^remoteaddress: / { sub(/^remoteaddress: /, ""); print; exit }' "$log_path")"

  if [[ -z "$actual" ]]; then
    die "ファイアウォール規則の RemoteAddress を読み取れませんでした（$log_path）。"
  fi

  if ! result="$(run_cidr_check "$expected" "$actual")"; then
    printf '%s\n' "$result" >&2
    die "ファイアウォール規則の RemoteAddress が LAN セグメントと一致しません（期待 $expected / 読み戻し $actual）。"
  fi

  printf '%s\n' "$result"
}

main() {
  local mode="confirm"
  local requested_ip=""
  local wsl_ip windows_ip lan_segment windows_temp output status log_path log_path_wsl proxied_ip

  while (($# > 0)); do
    case "$1" in
      --add)
        mode="add"
        ;;
      --remove)
        mode="remove"
        ;;
      --windows-ip)
        requested_ip="${2:-}"
        [[ -n "$requested_ip" ]] || die "--windows-ip には IP を指定してください。"
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        usage >&2
        die "不明な引数: $1"
        ;;
    esac
    shift
  done

  if [[ -n "$requested_ip" ]]; then
    validate_ipv4 "$requested_ip"
  fi

  require_commands

  wsl_ip="$(detect_wsl_ip)"

  if ! output="$(run_powershell "$(detect_windows_lan "$requested_ip")")"; then
    printf '%s\n' "$output" >&2
    die "Windows 側の LAN IP を特定できませんでした。--windows-ip で指定してください。"
  fi

  windows_ip="$(printf '%s\n' "$output" | awk -F= '$1 == "WINDOWS_IP" { print $2; exit }')"
  lan_segment="$(printf '%s\n' "$output" | awk -F= '$1 == "LAN_SEGMENT" { print $2; exit }')"
  windows_temp="$(printf '%s\n' "$output" | awk '$1 ~ /^WINDOWS_TEMP=/ { print substr($0, index($0, "=") + 1); exit }')"

  [[ -n "$windows_ip" ]] || die "Windows 側の LAN IP を特定できませんでした。--windows-ip で指定してください。"
  [[ "$lan_segment" =~ ^[0-9.]+/[0-9]{1,2}$ ]] || die "LAN セグメントを特定できませんでした: $lan_segment"
  [[ -n "$windows_temp" ]] || die "Windows 側の一時ディレクトリを特定できませんでした。"
  [[ "$windows_temp" != *"'"* ]] || die "一時ディレクトリのパスに ' は使えません: $windows_temp"

  printf 'WSL2 IP:        %s\n' "$wsl_ip"
  printf 'Windows LAN IP: %s\n' "$windows_ip"
  printf 'LAN セグメント: %s\n' "$lan_segment"
  printf '対象:           portproxy %s:%s / ファイアウォール規則 %s\n\n' \
    "$LISTEN_ADDRESS" "$TARGET_PORT" "$RULE_NAME"

  if [[ "$mode" == "confirm" ]]; then
    output="$(run_powershell "$(confirm_script)")"
    printf '%s\n' "$output"

    proxied_ip="$(printf '%s\n' "$output" | awk -v port="$TARGET_PORT" '$2 == port { print $3; exit }')"

    if [[ -z "$proxied_ip" ]]; then
      printf '\nportproxy に %s の設定はありません。--add で追加してください（UAC の承認が必要）。\n' "$TARGET_PORT"
    elif [[ "$proxied_ip" != "$wsl_ip" ]]; then
      printf '\n注意: portproxy の宛先 %s が現在の WSL2 IP %s と違います。--add で張り直してください。\n' \
        "$proxied_ip" "$wsl_ip"
    fi

    return 0
  fi

  log_path="$windows_temp\\herdr-mobile-client-lan-$mode.log"
  log_path_wsl="$(windows_to_wsl_path "$log_path")"

  if [[ "$mode" == "add" ]]; then
    require_verification_tools
  fi

  printf 'UAC のダイアログが表示されるので承認してください。承認されない場合は失敗として表示します。\n'

  if output="$(run_powershell "$(elevation_script "$(inner_script "$mode" "$wsl_ip" "$windows_ip" "$lan_segment" "$log_path")")")"; then
    status=0
  else
    status=1
  fi

  if [[ -f "$log_path_wsl" ]]; then
    printf '\n--- Windows 側の出力 (%s) ---\n' "$log_path"
    cat "$log_path_wsl"
    printf '\n'
  fi

  if [[ "$status" -ne 0 ]]; then
    if [[ -n "$output" ]]; then
      printf '%s\n' "$output" >&2
    fi

    die "処理に失敗しました。UAC の承認が拒否されたか、Windows 側のコマンドが失敗しています。"
  fi

  if [[ ! -f "$log_path_wsl" ]] || ! grep -q '^RESULT: ok$' "$log_path_wsl"; then
    if [[ -n "$output" ]]; then
      printf '%s\n' "$output" >&2
    fi

    die "処理の完了を確認できませんでした（出力を読み取れません: $log_path）。"
  fi

  if [[ "$mode" == "add" ]]; then
    verify_remote_address "$log_path_wsl" "$lan_segment"
  fi

  rm -f "$log_path_wsl"

  if [[ "$mode" == "add" ]]; then
    printf '完了: 追加しました。状態は scripts/lan-access.sh で確認できます。\n'
  else
    printf '完了: 削除しました。状態は scripts/lan-access.sh で確認できます。\n'
  fi
}

main "$@"
