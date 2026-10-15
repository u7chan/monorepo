import { render } from "preact"
import { App } from "./app"
import { startSession } from "./session"
import "./styles.css"

const root = document.getElementById("app")

if (!root) {
  throw new Error("#app が index.html にありません")
}

const session = await startSession()

render(<App initialToken={session.token} initialHealth={session.health} />, root)
