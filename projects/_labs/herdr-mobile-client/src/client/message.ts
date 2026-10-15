import type { HealthState } from "./health"

// 401 と到達不能を取り違えると、LAN や portproxy の設定をトークンの問題として探すことになる。
// 文言はこの 1 か所で分けておく。
export function healthMessage(state: HealthState): string | null {
  switch (state.status) {
    case "ok":
      return null
    case "unauthorized":
      return "トークンが違います。サーバーの起動ログに出た値を入力してください。"
    case "unreachable":
      return `サーバーに到達できません（トークンの不一致ではありません）。LAN 接続と portproxy / FW の設定を確認してください: ${state.reason}`
  }
}
