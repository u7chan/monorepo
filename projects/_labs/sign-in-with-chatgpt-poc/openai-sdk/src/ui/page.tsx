import type { FC } from "hono/jsx"

import type { DisplayError } from "../siwc/errors"

export const Page: FC = () => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Sign in with ChatGPT PoC — Phase 1 (openai SDK)</title>
      <link rel="stylesheet" href="/static/app.css" />
      <script type="module" src="/static/app.js" />
    </head>
    <body>
      <header>
        <h1>Sign in with ChatGPT PoC</h1>
        <p class="subtitle">
          Phase 1: OpenAI公式SDK（<code>openai</code>）+ SIWC /
          ローカル・単一ユーザー専用
        </p>
      </header>

      <main>
        <section class="card">
          <h2>接続</h2>
          <div id="banner" class="banner" hidden />
          <div id="connection-body" class="loading">
            読み込み中…
          </div>
        </section>

        <section class="card" id="chat-card" hidden>
          <h2>推論（POST /v1/responses、store:false / stream:true）</h2>
          <div class="row">
            <label for="model-select">モデル</label>
            <select id="model-select" />
            <button id="reload-models" type="button">
              再取得
            </button>
          </div>
          <label for="instructions">instructions</label>
          <textarea id="instructions" rows={2}>
            {"You are a helpful assistant. Answer concisely."}
          </textarea>
          <div id="transcript" class="transcript" aria-live="polite" />
          <form id="chat-form">
            <label for="prompt">入力（Ctrl + Enter で送信）</label>
            <textarea id="prompt" rows={3} placeholder="メッセージを入力" />
            <div class="row">
              <button id="send" type="submit">
                送信
              </button>
              <button id="cancel" type="button" disabled>
                中断
              </button>
            </div>
          </form>
          <div class="row debug" id="debug-row" hidden>
            <span class="debug-label">デバッグ:</span>
            <label class="checkbox">
              <input id="unsupported-temperature" type="checkbox" />
              未対応フィールド <code>temperature=0</code> を付ける
            </label>
          </div>
          <pre id="chat-status" class="status" aria-live="polite" />
        </section>
      </main>

      <footer>
        <p>
          トークンはサーバー側の <code>~/.config</code>{" "}
          配下（0600）にのみ保存し、ブラウザには返しません。
        </p>
      </footer>
    </body>
  </html>
)

export const ErrorPage: FC<{ error: DisplayError }> = ({ error }) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <title>SIWC PoC — エラー</title>
      <link rel="stylesheet" href="/static/app.css" />
    </head>
    <body>
      <header>
        <h1>サインインを完了できませんでした</h1>
      </header>
      <main>
        <section class="card">
          <p class="error-message">{error.message}</p>
          <dl class="detail">
            <dt>status</dt>
            <dd>{error.status === null ? "-" : String(error.status)}</dd>
            <dt>code</dt>
            <dd>{error.code ?? "-"}</dd>
            <dt>request ID</dt>
            <dd>{error.requestId ?? "-"}</dd>
          </dl>
          {error.hint === null ? null : <p class="hint">{error.hint}</p>}
          <p>
            <a href="/">戻る</a>
          </p>
        </section>
      </main>
    </body>
  </html>
)
