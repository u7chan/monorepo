// cloudflared 2026.11.2 (linux/amd64) の実出力を、ホスト名・IP・ID・拠点を架空の値に置き換えて採ったもの。
// 固定した版を上げるたびに取り直す (docs/service-tunnel.md の「版の更新」)。

const EMPTY_CONFIG = "2026-11-28T05:56:39Z ERR Configuration file /dev/null was empty";

const DISCLAIMER =
  "2026-11-28T05:56:39Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms. If you intend to use Tunnels in production you should use a pre-created named tunnel by following: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps";

const REQUESTING = "2026-11-28T05:56:39Z INF Requesting new quick Tunnel on trycloudflare.com...";

/** 起動のたびに出る、空の設定を読んだことの Error 行。失敗ではない */
export const EMPTY_CONFIG_LINE = EMPTY_CONFIG;

export const QUICK_TUNNEL_HOSTNAME = "example-fixture-sample-tunnel.trycloudflare.com";

const BOX_RULE = `+${"-".repeat(92)}+`;
const boxRow = (text: string): string => `|${`  ${text}`.padEnd(92)}|`;

/** 作成に成功した起動ログ。URL は表に出る (`/quicktunnel` が引けないときの代替取得の入力) */
export const QUICK_TUNNEL_CREATED_LOG = [
  EMPTY_CONFIG,
  DISCLAIMER,
  REQUESTING,
  `2026-11-28T05:56:43Z INF ${BOX_RULE}`,
  `2026-11-28T05:56:43Z INF ${boxRow("Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):")}`,
  `2026-11-28T05:56:43Z INF ${boxRow(`https://${QUICK_TUNNEL_HOSTNAME}`)}`,
  `2026-11-28T05:56:43Z INF ${BOX_RULE}`,
  "2026-11-28T05:56:43Z INF Cannot determine default configuration path. No file [config.yml config.yaml] in [~/.cloudflared ~/.cloudflare-warp ~/cloudflare-warp /etc/cloudflared /usr/local/etc/cloudflared]",
  "2026-11-28T05:56:43Z INF Version 2026.11.2 (Checksum 56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf)",
  "2026-11-28T05:56:43Z INF GOOS: linux, GOVersion: go1.27.4, GoArch: amd64",
  "2026-11-28T05:56:43Z INF Settings: map[config:/dev/null grace-period:5s ha-connections:1 metrics:127.0.0.1:20241 no-autoupdate:true url:http://127.0.0.1:8080]",
  "2026-11-28T05:56:43Z INF Generated Connector ID: 00000000-0000-4000-8000-000000000001",
  "2026-11-28T05:56:43Z INF Initial protocol quic",
  "2026-11-28T05:56:43Z INF ICMP proxy will use 192.0.2.10 as source for IPv4",
  "2026-11-28T05:56:43Z INF ICMP proxy will use 2001:db8::10 as source for IPv6",
  "2026-11-28T05:56:43Z INF Starting metrics server on 127.0.0.1:20241/metrics",
  "2026-11-28T05:56:43Z INF Tunnel connection curve preferences: [X25519MLKEM768 CurveID(65074) CurveP256] connIndex=0 event=0 ip=203.0.113.7",
  "2026-11-28T05:56:44Z INF Registered tunnel connection connIndex=0 connection=00000000-0000-4000-8000-000000000002 event=0 ip=203.0.113.7 location=xxx01 protocol=quic",
  "",
].join("\n");

/** SIGTERM で止めたときの出力。`ERR` 行が並ぶが、これは正常な終了 */
export const GRACEFUL_SHUTDOWN_LOG = [
  "2026-11-28T05:56:47Z INF Initiating graceful shutdown due to signal terminated ...",
  "2026-11-28T05:56:47Z INF Retrying connection in up to 2s connIndex=0 event=0 ip=203.0.113.7",
  "2026-11-28T05:56:47Z ERR Connection terminated connIndex=0",
  "2026-11-28T05:56:47Z ERR no more connections active and exiting",
  "2026-11-28T05:56:47Z INF Tunnel server stopped",
  "2026-11-28T05:56:47Z INF Metrics server stopped",
  "",
].join("\n");

/** `GET /ready` が 200 のときの本文 (接続が 1 本以上) */
export const READY_BODY = '{"status":200,"readyConnections":1,"connectorId":"00000000-0000-4000-8000-000000000001"}';
/** 接続がまだ無いときの本文 (503) */
export const NOT_READY_BODY =
  '{"status":503,"readyConnections":0,"connectorId":"00000000-0000-4000-8000-000000000001"}';

/** 作成が 429 で拒否されたときの出力。末尾の行はログの接頭辞が付かない */
export const PROVISIONING_REJECTED_LOG = [
  "2026-11-28T04:04:05Z ERR Configuration file /dev/null was empty",
  DISCLAIMER.replace("2026-11-28T05:56:39Z", "2026-11-28T04:04:05Z"),
  "2026-11-28T04:04:05Z INF Requesting new quick Tunnel on trycloudflare.com...",
  "quick tunnel provisioning failed with status 429",
  "",
].join("\n");

/** 作成 API へ届かなかったときの出力 (DNS の問い合わせ先は予約アドレスへ置き換えてある) */
export const NETWORK_FAILURE_LOG = [
  EMPTY_CONFIG,
  DISCLAIMER,
  REQUESTING,
  'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com on 192.0.2.53:53: dial udp 192.0.2.53:53: connect: network is unreachable',
  "",
].join("\n");
