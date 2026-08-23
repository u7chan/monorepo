// エージェント進行状況の人間可読ログ。
// 後段で構造化ロガー (pino 等) へ置き換える前提の仮実装であり、
// 呼び出し側はこのファイルの関数経由のみとする。

// タイムスタンプはシステムタイムゾーンのローカル時刻 (コンテナでは TZ env で制御)。
function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function logAgent(message: string) {
  console.log(`[agent] ${timestamp()} ${message}`)
}

export function logAgentPrompt(text: string) {
  const preview = text.length > 80 ? `${text.slice(0, 80)}...` : text
  logAgent(`prompt: "${preview}"`)
}
