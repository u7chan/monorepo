import { render } from "preact";
import "./styles.css";

function App() {
  return (
    <>
      <header class="up-header">
        <span class="up-brand">Usage</span>
        <span class="up-caption">Codex / OpenCode Go</span>
      </header>
      <main class="up-main">
        <section class="up-card">
          <h1 class="up-heading">利用枠</h1>
          <p class="up-caption">利用枠の取得はまだ実装されていません。</p>
        </section>
      </main>
      <footer class="up-footer">
        <span class="up-caption">表示専用</span>
      </footer>
    </>
  );
}

const root = document.getElementById("app");

if (!root) {
  throw new Error("#app が index.html にありません");
}

render(<App />, root);
