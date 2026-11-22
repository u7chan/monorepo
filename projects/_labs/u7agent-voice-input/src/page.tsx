export function Page() {
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>u7agent 音声入力スパイク</title>
        <link rel="stylesheet" href="/style.css" />
        <script type="module" src="/app.js" />
      </head>
      <body>
        <main>
          <header>
            <h1>u7agent 音声入力スパイク</h1>
            <p>OpenAI gpt-live-transcribe / WebRTC</p>
          </header>
          <section aria-labelledby="key-title">
            <h2 id="key-title">OpenAI API キー</h2>
            <p id="key-help">キーはローカルサーバーのメモリにのみ登録し、再起動で消去します。</p>
            <form id="key-form" autocomplete="off">
              <div class="controls">
                <input
                  id="api-key"
                  type="password"
                  aria-labelledby="key-title"
                  aria-describedby="key-help"
                  autocomplete="off"
                  spellcheck={false}
                  maxlength={1024}
                  required
                  disabled
                />
                <button id="register-key" type="submit" disabled>登録</button>
                <button id="clear-key" type="button" disabled>登録解除</button>
              </div>
            </form>
            <p id="key-status" role="status">登録状態を確認中…</p>
          </section>
          <section aria-labelledby="voice-title">
            <h2 id="voice-title">文字起こし</h2>
            <p>開始を押すと、マイクの音声を OpenAI へ送ります。録音は最長 2 分です。</p>
            <div class="controls">
              <button id="start" type="button" disabled>録音開始</button>
              <button id="stop" type="button" disabled>停止・確定</button>
            </div>
            <p id="run-status" role="status">待機中</p>
            <h3>途中テキスト</h3>
            <p id="partial" class="partial" aria-label="途中テキスト"></p>
            <label for="transcript">確定テキスト（編集可）</label>
            <textarea id="transcript" rows={5} autocomplete="off" />
            <dl>
              <div>
                <dt>録音開始 → 最初の途中表示</dt>
                <dd id="first-delta">—</dd>
              </div>
              <div>
                <dt>停止 → 確定</dt>
                <dd id="stop-to-final">—</dd>
              </div>
            </dl>
          </section>
        </main>
      </body>
    </html>
  );
}
