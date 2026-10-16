#!/usr/bin/env bash
# lan-access.sh と pair.sh で共有する Windows 側の処理。source して使う（単体では何もしない）。
# 実行は WSL2 上での直接実行を前提にしている（powershell.exe が要る）。

die() {
  printf 'エラー: %s\n' "$*" >&2
  exit 1
}

# 埋め込む値には `2>&1` のような & が入る。二重引用符で囲んだ置換では & は特別扱いされないため、
# エスケープせずそのまま埋め込む（エスケープすると \& が残って PowerShell の構文エラーになる）。
substitute() {
  local template="$1"
  local placeholder="$2"
  local value="$3"

  printf '%s\n' "${template//"$placeholder"/"$value"}"
}

run_powershell() {
  local script="$1"
  local encoded

  encoded="$(printf '%s' "$script" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)"

  # PowerShell の標準出力は CRLF なので、bash 側の比較と grep のために LF に揃える。
  powershell.exe -NoProfile -EncodedCommand "$encoded" | tr -d '\r'
}

detect_windows_lan() {
  local requested_ip="$1"
  local script

  script="$(cat <<'SCRIPT'
$ProgressPreference = "SilentlyContinue"
$ErrorActionPreference = "Stop"

$requested = "@@WINDOWS_IP@@"

if ([string]::IsNullOrEmpty($requested)) {
  $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -AddressFamily IPv4 | Sort-Object RouteMetric, ifIndex | Select-Object -First 1

  if ($null -eq $route) {
    throw "no default route found"
  }

  $address = Get-NetIPAddress -InterfaceIndex $route.ifIndex -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "169.254.*" } |
    Select-Object -First 1
} else {
  $address = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $requested -ErrorAction SilentlyContinue | Select-Object -First 1
}

if ($null -eq $address) {
  throw "no IPv4 address found"
}

$octets = $address.IPAddress.Split(".") | ForEach-Object { [int]$_ }
$prefix = [int]$address.PrefixLength
$network = @()

for ($i = 0; $i -lt 4; $i++) {
  $bits = [Math]::Max([Math]::Min($prefix - $i * 8, 8), 0)
  $mask = [int](256 - [Math]::Pow(2, 8 - $bits))
  $network += (($octets[$i] -band $mask).ToString())
}

Write-Output ("WINDOWS_IP=" + $address.IPAddress)
Write-Output ("WINDOWS_INTERFACE=" + $address.InterfaceAlias)
Write-Output ("LAN_SEGMENT=" + ($network -join ".") + "/" + $prefix)
Write-Output ("WINDOWS_TEMP=" + $env:TEMP)
SCRIPT
)"

  substitute "$script" "@@WINDOWS_IP@@" "$requested_ip"
}
