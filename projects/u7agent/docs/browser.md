# ヘッドレスブラウザ（同梱物と検証）

サンドボックスの `bash` から `u7agent-browser` を叩き、ヘッドレス Chromium（chromium-headless-shell）でアプリや HTML を開いて確認・撮影する。**使い方の正は同梱スキル `server/src/builtin-skills/browser/SKILL.md`**（エージェントは仮想パス `<root>/.u7agent/builtin-skills/browser/SKILL.md` を `read` する）で、既定値・上限・コマンドとフラグの一覧・終了コードはコードとテストが正（`server/src/browser/`、`server/test/browser-*.test.ts`、`server/src/builtin-skills.ts` の `VERSIONS`）。ここには、利用者から見た振る舞いが変わらない変更では書き換えが要らない契約と理由だけを書く。

背景は [#1976](https://github.com/u7chan/monorepo/issues/1976): ブラウザを持ち込む標準手段が無く、実行中のエージェントが `apt` を使わず手作業で依存を揃える状態にあった。置き場（`~/.cache` / `/tmp`）は永続化契約の外にありコンテナ再作成で消えるため、配布セットを固定して同梱する。

## 同梱物と入口

- 版の正本は `playwright-core` の `browsers.json` で、独立した版定数を持たない（ドライバとブラウザの対応を公式のセットへ固定する）。取得は `scripts/install-browser.mjs` が `playwright-core` の CLI へ委ね、既にある版は取り直さない（コンテナ再作成でイメージの同梱物を取り直さない）。配布先はイメージが `/ms-playwright`、dev が `PLAYWRIGHT_BROWSERS_PATH`（未設定はホームのキャッシュ）で、`test` / `final` / dev が同じ版を使う。配布物が持つ著作権表示のファイルは消さずに残す
- 入口は `u7agent-browser`（イメージは `/usr/local/bin`、dev は `pnpm dev` が `$HOME/.local/libexec/u7agent` へ置き、サンドボックスへ `PATH` と `PLAYWRIGHT_BROWSERS_PATH` を渡す）。**呼び出し元の cwd を変えない**（成果物の保存先の基準にする）ため、`--import tsx` の解決が cwd に依存する分を入口が絶対パスで埋める
- `server/src/agent.ts` の `appendSystemPrompt` は、コンテナにあるものとして `chromium (headless, u7agent-browser)` を名指しする。`final` ステージの `command -v u7agent-browser` 検査とセットで、入口を落としたイメージはビルドで落ちる

## 保存と出力の契約

- `shot` は既存ファイルを上書きせず一意な名前で cwd へ保存し、**実際の cwd 相対パスを stdout へ返す**（`generate_image` と同一契約）。エージェントは返されたパスを `read` して目視し、Markdown へ貼る。要求したパスを返すと、`read` と Markdown の解決が二重になって実際のファイルとずれる
- `read` が画像を返すのはモデルが画像を扱えるときだけ。扱えないモデルには注記だけが返り、画像は送られない（スキル本文がこの断り方を定める）
- `check` はアプリの失敗（console / 例外 / 4xx・5xx / 失敗したリクエスト / 遷移）とツールの起動失敗を別の終了コードにする。検証が動いたうえでの失敗を、動かなかった失敗と混ぜない

## single-shot・残存物・同時実行

- 呼び出しは single-shot で、呼び出しをまたいで状態を持たない。一時領域（`HOME` / `TMPDIR` / Playwright のプロファイル）は呼び出しごとに `/tmp` の内側へ作り、正常 / 例外 / 期限超過のどれでも削除する。外側の abort は SIGKILL で `finally` が走らないため、終了済みと確認できる古い領域は次の起動時に掃除する（生存中の pid は残し、PID の再利用は起動時刻の照合で見分ける。`/proc` が読めないときは不明として残す）
- 期限超過では、読み込み中に待機するスクリプトも含めて実行を打ち切り、回収の完了を待ってからプロセスを終える。任意コードはブラウザを閉じてもタイマーなどを掴んだまま動き続け得るため、回収を `finally` と `process.exitCode` に任せると呼び出しが期限を過ぎて残る
- 同時実行は既定で上限を持ち、置き場の下の `slots/<index>` に 1 つだけ枠のファイル（`<pid>-<起動時刻>`、名前が所有者）を置く入場制御で、ブラウザを起動する前に制限する（隔離した一時領域は総資源の上限にならない）。index のディレクトリ作成とファイル作成が原子的なので同じ index を取れるのは 1 呼び出しだけになり、index は上限までしか無いため上限を超えない。上限に達した呼び出しは待たずに終了する。終了済みと確認できる枠は、観測した世代のファイルを自分の世代名へ `rename` して引き継ぐ（壊す対象が世代名で条件付けられるため、古い所有者を読んだ後に遅れて再開した呼び出しが生存中の枠を消すことはない）。中断した残りは次回の入場時に回復する: 空になった index は `rmdir`（空のときだけ成功する）で回収し、終了済みの枠は引き継ぐので、どの段階で SIGKILL されても枠数は既定に戻る。所有者名でないファイルや複数の枠が残った index は消さずに容量として扱う（fail-closed）

## 外部到達の境界

標準経路（`shot` / `dom` / `check` / `--self-test`）はループバック以外へ通信しない。許可する表記は `127.0.0.1` / `localhost` / `[::1]` に限る（`127.0.0.2` などの別名は拒否される）。`data:` は通信ではないため対象外で、`--self-test` とイメージの probe はこの経路で fixture を開く。

実装は 2 段にする。

1. **ブラウザのネットワーク層で止める（本命）**: ラッパーが 127.0.0.1 の一時ポートを bind して deny-all proxy を立て、`--proxy-server` でそこへ向ける。`--proxy-bypass-list=<-loopback>;127.0.0.1;localhost;[::1]` で Chromium の暗黙のバイパス規則を外し、許可するループバックだけを明示登録する。非ループバックの通信（redirect 先・サブリソース・iframe・popup・WebSocket）はすべて proxy に到達して拒否される。proxy のポートは CLI 自身が所有するので、`ip_unprivileged_port_start` や capability に依存せず、他プロセスに奪われない
2. `route` / `routeWebSocket` でループバック以外を明示的に拒否する（エラーの意味を分かりやすくする）

1 が要る理由は 2 つある。**Playwright の route ハンドラーは redirect では最初の URL にしか呼ばれない**（採用版の型定義に明記があり、実装も redirected request を `Fetch.continueRequest` で通す）。加えて **Chromium の暗黙バイパス規則はループバックだけでなく link-local（`169.254/16` / `fe80::/10`）も含む**ため、proxy を置くだけでは IP literal の redirect で抜けられる。`<-loopback>` で暗黙規則を外し、ループバックを明示登録して初めて「ループバック以外は通らない」が成立する。

WebSocket も HTTP と同じ規則に揃える（ローカルの WS は許可し、WS を使うアプリの検証を残す）。Service Worker は `serviceWorkers: 'block'` で登録させない（route は Service Worker のリクエストを横取りしない）。

**境界ではないもの**: `run` は任意コードを実行するため、ポリシーを解除できる（`unrouteAll()`、`page.route` が context の route より優先されること、`context.browser()`、`context.request` がブラウザのプロキシを通らないこと、自分でブラウザを起動すること）。また `curl` で外部 HTML を取得してループバックで serve する迂回と、生の `bash` からの直接通信は残る。**OS レベルの egress 境界ではない**。この境界の実効性は「標準経路が外部へ出ない」ことに限る。外部ページの取得・検証（`curl` で取って serve する迂回を含む）は非ゴールとして扱う。

## 実行環境の制約（実測）

- **`--no-sandbox` は現在の実行環境で必須**。unprivileged user namespaces が使えないことの観測で、Debian 13 一般の必然ではない。u7agent の bash は Landlock ラッパー（`scripts/landlock-exec.py`）が `PR_SET_NO_NEW_PRIVS` を立ててから exec するため、setuid な `chrome-sandbox` を同梱しても効かない。CLI は常にこの引数を付ける
- **`HOME` は許可 root の内側へ**。`HOME` が許可 root の外だと `Failed to create headless user data directory container.`、`--user-data-dir` を指定した場合は `chrome_crashpad_handler: --database is required` で落ちる。Playwright はプロファイルを自分で管理するので `--user-data-dir` を args へ渡さない。CLI は呼び出しごとの一時領域を `HOME` にする
- 日本語ラベルと絵文字のために `fonts-ipafont-gothic` と `fonts-noto-color-emoji` を入れる（同梱物で描画されるので、エージェントがフォントを足す必要は無い）
- 無害だがログを汚すもの: dbus 接続失敗、`Fontconfig error: Cannot load default config file`（`fontconfig` を入れない場合）、`Failed to adjust OOM score of renderer`（非 root のため）
- **ログと原因は一対一ではない**。1 つの原因が複数行に出るし、無害な行も混ざる。並んでいる行と終了コードをまとめて読む（見分け方はスキル本文が持つ）

## 保証しないこと

- **レンダラーサンドボックスが無い**。renderer が侵害されたときに OS サンドボックスが被害を抑えない。読み取りは Landlock の対象外（`/workspace` の他プロジェクトや `/app` を読める。会話ストアはサンドボックスへマウントしないので会話ログは読めない）
- GPU を使わないソフトウェアレンダリング前提で、WebGL / 動画 / 音声再生は対象外。headless なので実機のタッチ / 音は近似で、実機固有の挙動は確かめられない
- 外部ページと、認証が絡む検証（秘密の注入・storage state の永続化・実サービスのログイン）は対象外
- headed ブラウザ / VNC / noVNC のリモート配信、Firefox / WebKit、MCP 経由のブラウザ、第三者ブラウザサービスは対象外
- HMR 付き Vite アプリの**サービス経由**の検証は対象外（BFF → sandbox の WebSocket 転送が未実装。サンドボックス内のブラウザから `127.0.0.1:<port>` を直接開く経路はこの制限を受けない）
- `browser` は BFF ローカルの一級ツールにしない。エージェントは `bash` から CLI を叩く
