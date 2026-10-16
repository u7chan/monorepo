import type { HealthState } from "./health"
import type { PairFailure } from "./pair"

export type FormMessageInput = {
  health: HealthState | null
  pair: PairFailure | null
}

// 401 と到達不能を取り違えると、LAN や portproxy の設定をトークンの問題として探すことになる。
// 文言はこの 1 か所で分けておく。
export function healthMessage(state: HealthState): string | null {
  switch (state.status) {
    case "ok":
      return null
    case "unauthorized":
      return "トークンが違います。サーバーの起動ログに出た値を入力してください。"
    case "unreachable":
      return unreachableMessage(state.reason)
  }
}

export function pairMessage(failure: PairFailure): string {
  switch (failure.status) {
    case "invalid":
      return "QR のコードが無効です（期限切れの可能性があります）。もう一度 QR を出してください"
    case "rate-limited":
      return "試行が多すぎます。少し待ってから、もう一度 QR を出してください"
    case "unreachable":
      return unreachableMessage(failure.reason)
  }
}

// 手入力の結果 (health) が付いたら、起動時のペアリングエラーより新しい結果を優先する。
// 古い QR の案内が残ると、401 と到達不能で文言を分けるという契約が崩れる。
export function formMessage(input: FormMessageInput): string | null {
  if (input.health !== null) {
    return input.health.status === "ok" ? null : healthMessage(input.health)
  }

  return input.pair === null ? null : pairMessage(input.pair)
}

function unreachableMessage(reason: string): string {
  return `サーバーに到達できません（トークンの不一致ではありません）。LAN 接続と portproxy / FW の設定を確認してください: ${reason}`
}
