import { render } from "preact"
import { App, PairProgress } from "./app"
import { clearPairHash, exchangePairCode, parsePairHash } from "./pair"
import { startSession } from "./session"
import { saveToken } from "./token"
import "./styles.css"

const root = document.getElementById("app")

if (!root) {
  throw new Error("#app が index.html にありません")
}

const pairCode = parsePairHash(location.hash)

if (pairCode === null) {
  const session = await startSession()

  render(<App initialToken={session.token} initialHealth={session.health} pair={null} />, root)
} else {
  // 交換の間は入力画面を出さない。App は state を props の初期値からしか取らないため、
  // 確認中は別の画面として描き、交換後に App を新しく載せる（key で載せ直すより意図が読める）。
  render(<PairProgress />, root)

  const pair = await exchangePairCode(pairCode)

  clearPairHash()

  if (pair.status === "ok") {
    saveToken(pair.token)

    const session = await startSession()

    render(<App initialToken={session.token} initialHealth={session.health} pair={null} />, root)
  } else {
    render(<App initialToken={null} initialHealth={null} pair={pair} />, root)
  }
}
