import { render } from "preact"
import { App } from "./app"
import { loadHealth } from "./health"
import "./styles.css"

const root = document.getElementById("app")

if (!root) {
  throw new Error("#app が index.html にありません")
}

render(<App health={await loadHealth()} />, root)
