# ADR 0017: 最小プロンプトの送信（5 時間窓の開始と接続確認）

- Status: accepted
- Date: 2026-10-31

## 背景

Codex の 5 時間の利用枠は、前の窓が終わったあとに最初のメッセージを送った時点で始まる
（[公式](https://help.openai.com/en/articles/20001498-how-resets-work-in-codex)）。開始時刻を選びたいが、
ポータルは利用枠を見るだけで、意図的に開始する手段がない。OpenCode Go は登録した API キーが
推論経路でも使えるかを確かめたい。

この 2 つは、どちらも「最小のプロンプトを 1 回送る」だけで足りる。応答本文には用がない。

スパイク（2026-10-31、Pi の資格情報を使い、ポータルの資格情報には到達できなかった）で分かったこと:

- `/backend-api/wham/usage` は `rate_limit.primary_window` に 7 日窓 1 本だけを返すアカウントがある。
  `limit_window_seconds` は 604800 のみで、18000（5 時間）の窓は応答に一度も現れなかった。
  同じアカウントで responses の送信が続いている最中でも、窓は増えず `used_percent` も動かなかった。
- `secondary_window` はキーが存在し値が `null` で返る。キーの欠損ではない。
- 送信しても利用枠の表示にすぐ反映されないことがある（ユーザー観測）。
- OpenCode Go の `deepseek-v4.1-flash` / `low` / `maxTokens: 16` の 1 回は HTTP 200・`stopReason: stop` で通った。
  このモデルの `getSupportedThinkingLevels()` は `low` / `high` / `max` で、`off` を持たない。

5 時間窓が API に出ないアカウントがあるため、「開始済み」を判定する前提が成立しない。
そこで Codex は開始済み判定を持たず、OpenCode Go の接続確認と同じ probe の契約に寄せる。

## 決定

- 送信は pi-ai の provider adapter（`openaiCodexProvider()` / `opencodeGoProvider()`）を直接使う。
  エージェントは使わず、system prompt・tools・会話履歴もアプリからは足さない。プロンプトは
  サーバ側の固定 1 文（`Reply with the single word OK.`）だけで、利用者の入力を混ぜない。
- 認証の境界は ADR 0005 のまま。Codex は `CodexAuth.credential()` が返す access token を adapter に渡し、
  `auth.json` を独自に解析しない。account id は adapter が token から読む。
- モデルと思考レベルはコードに既定値を置かず、`DATA_DIR/settings.json`（Codex）と
  `opencode-accounts.json`（OpenCode Go のアカウントごと）に保存する。未設定のあいだ送信の入口を出さない。
- モデルと思考レベルの正は `GET /api/probe/models` が返す catalog（pi-ai 同梱の `getModels()`）にする。
  保存時と送信時の両方で照合し、`clampThinkingLevel()` による補正には任せない。
- HTTP status は adapter の `onResponse` ではなく、request-local の `fetch` wrapper で控える。
  OpenAI-compatible / Responses の adapter は失敗時に `onResponse` を呼ばないため。
- 成功は HTTP 200 では決めない。stream を最後まで消費し、`result()` の `stopReason` が
  `error` / `aborted` でないことを確かめる。`length` は probe としては成功とする。
- 上限は `AbortSignal.timeout(30_000)` を adapter に渡して stream 全体に掛ける。`finally` で
  source ごとの single-flight を必ず解放し、中断後に adapter が返らない場合も実行中の印を残さない。
- 失敗は固定のコードへ丸める。401 / 403 は Codex が `reauth_required`、OpenCode Go が `invalid_key`、
  429 は `limit_reached`、400 / 404 は `model_unavailable`、それ以外と stream の異常終了は `unavailable`。
  上流の本文・`errorMessage` は返さない・ログに出さない。
- Codex のボタンは「5時間を開始」。無効条件は未サインイン・取得前で snapshot なし・`limitReached`・
  いずれかの窓が 100%・実行中だけ。「開始済み」は判定しない。5 時間窓が返らないアカウントでは
  週次だけを見ることになり、その 100% が「もう使えない」を意味する。
- 送信後は `sampler.kick()` を試すが、その完了はリセット時刻の更新を意味しない。取得できたときだけ
  リセット時刻を出し、反映遅れを失敗として扱わない。kick の失敗は probe の結果に混ぜない。
- OpenCode Go の接続確認は kick しない。全 source の追加取得は 1 アカウントの確認には重すぎる。

## 理由

応答本文を使わないので、保持するのは成否・latency・固定コードだけになり、保存・ログ・応答のどこにも
上流の文面が入らない。開始済み判定を持たないのは、判定できない状態を推測で埋めると
「押せないのに窓が空いている」「押せるのに既に始まっている」のどちらも起こり得るため。
再送は 5 時間を延ばさず、窓が動いたかは送信後に取得できた snapshot でしか分からない。
迷ったら押せる側に倒し、結果は利用枠の表示で確かめてもらう。

採用しない案:

- `ModelRuntime` 経由で送る: 認証の境界として作ったもので、送信の status や stream の終端を扱えない。
- 開始済みを `usedPercent` で判定する: 5 時間窓が返らないアカウントでは週次の値を見ることになり、
  週次が 1% でも「開始済み」と誤判定する。
- `onResponse` で status を控える: OpenAI-compatible / Responses の adapter は失敗時に呼ばない。
- 上流の本文や `errorMessage` を画面に出す: 何が返るか分からない文面を LAN 内の画面へ流す理由がない。

## 影響

- probe の対象は OpenAI-compatible / OpenAI Responses / Anthropic Messages / Codex Responses の
  adapter に限る。Google の adapter は custom fetch を受け付けず status を捕捉できないため対象外。
  そのため catalog から `google-generative-ai` のモデルを除く（現版の OpenCode Go は 29 件中 1 件）。
- `DATA_DIR/settings.json` は秘密ではないが、他と同じ 0600・atomic write にする。壊れたファイルは
  「未設定」として扱い、警告を 1 回だけ出して fallback しない。設定が消えると機能は黙って無効になる。
- Codex adapter は `maxTokens` を body に載せない。出力は `textVerbosity` の既定 low と短いプロンプトで抑える。
  この前提は `@earendil-works/pi-ai` の固定バージョンを更新するときに確認する。
- OpenCode Go の `maxTokens: 16` は API ごとの出力上限で、総コストを 16 token に抑える意味ではない。
- Codex の 5 時間窓が API に露出しないアカウントでは、開始ボタンは週次の残りだけを見て有効・無効になる。
- OpenCode Go の窓が会話と無関係に回ることは、スパイクでは観測できなかった（未使用アカウントを用意できず、
  5 時間待たない方針）。接続確認はキーと推論経路の確認であり、窓の起点には依存しない。
