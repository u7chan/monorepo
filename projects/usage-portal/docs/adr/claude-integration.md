# Claude との連携（公式 CLI・取得の契機・開始予約）

- Status: accepted
- Date: 2026-11-23

## 背景

Claude の Pro / Max の利用枠（5 時間・週次）をダッシュボードに出す。取得経路の候補は次のとおり。

- Usage and Cost Analytics API は Console / Enterprise 組織向けで、Admin API の認証が要る。個人のサブスクリプションでは
  使えず、窓の残りも返さない。データも通常 4 時間遅れる。
- 公式 CLI の `claude -p "/usage"` は、窓ごとの使用率とリセット時刻を返す。モデルは呼ばず、計上は
  `num_turns: 0`・トークン 0・コスト 0 になる。
- Claude Code の Legal and compliance は、Claude.ai の資格情報やセッショントークンを第三者のアプリが
  収集・保存・仲介することを認めない。一方、改変していない Claude Code に、利用者が自分のサブスクリプションで
  サインインすることは妨げない。機械的な呼び出しの検知基準は公開されていない。

Codex と OpenCode Go はバックグラウンドで取得するが、Claude はアカウントを失う影響が大きいので同じ周期では取らない。
このポータルは PIN 認証・LAN 内・自分 1 人専用で、第三者に Claude を提供しない。

## 決定

### 取得の契機

- 周期の sampler には乗せない。取るのは次の 2 つだけにする。
  - 画面を開いたとき（初回表示と、タブが見える状態へ戻ったとき）。前回の取得から 15 分以内なら CLI を起動せず、
    保存済みの値を使う。
  - カードの `⋮` メニューの「更新」。15 分の制限は受けないが、前回の試行から 60 秒は空ける。
- 画面を開いている間の定期取得はしない。取得から 15 分を超えた値は `stale` として出し、更新は手動にする。
- 取得は認証必須・同一 origin 検査つきの `POST /api/claude/refresh`。`GET /api/usage` は保存済みの値を読むだけで、
  上流へ取りに行かない。同時要求は single-flight、CLI のタイムアウトは 15 秒で、超えたら kill する。
- 失敗しても自動では再試行しない。次に取るのは、15 分後以降に画面を開いたときか手動更新。

### 取得方法

- 公式 `claude` を子プロセスとして起動し、`claude -p "/usage" --output-format json --no-session-persistence` の
  `result`（文字列）を読む。利用枠についてはトークンを取り出して API を直接叩かず、`.credentials.json` も読まない
  （リセット枠の手動取得だけは下の例外）。
- 子プロセスには `PATH` / `HOME` / `CLAUDE_CONFIG_DIR` / `TZ=UTC` だけを渡し、cwd は空の一時ディレクトリにする。
- `Current session` を rolling（18000 秒）、`Current week (all models)` を weekly（604800 秒）の窓にする。
  `N% used` と `resets <日時> (<IANA タイムゾーン>)` を読む。日時は通常年が無く、リセットが翌年に落ちるときだけ年が付く。
  年が無ければ括弧内のタイムゾーンで解釈して、今より後で最も近い日時を採る。年と時刻の区切りは `, ` と ` at ` の
  どちらも受ける。
- 認識できる行だけを窓にする。1 つも読めなければ `schema` エラー。モデル別の窓は、必要になったときに足す。
- 正規化した `ProviderSnapshot`（`provider: "claude"`、source id は `claude` 固定、plan は `subscriptionType`）と
  sample だけを既存のテーブルへ保存する。CLI の出力本文は DB・ログ・応答に残さない。
- 公式バイナリは改変せずに image へ入れ、自動更新は止めてバージョンを固定する。版を上げるときは fixture の差分を見る。
- 版は `stable` チャネル（`https://downloads.claude.ai/claude-code-releases/stable`）に追従する。
  Dependabot はこの取得経路を追えないため、
  [.github/workflows/claude-cli-version-check.yml](../../../../.github/workflows/claude-cli-version-check.yml) が週次で
  `stable` と Dockerfile の固定版を比べ、新しい版があれば PR を作る。マージと fixture の再確認は人間が行う。
  固定版が `stable` より進んでいるときは下げる提案をしない（`stable` は遅れて追いつく）。
  `GITHUB_TOKEN` で PR を作るため、repository で GitHub Actions の PR 作成を許可しておく必要がある。

### リセット枠（手動取得）

- Claude の利用枠とは別に、リセット枠（`cedar_ember` の grant）を読む。`claude -p "/usage"` の text には出ないため、
  OAuth の usage API（`GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1`）を直接読む。
  この 1 経路だけ、`CREDENTIAL_DIR/claude/.credentials.json` の access token をメモリ上で読む例外とする。
- token は保存・ログ・応答に出さない。refresh は CLI に任せ、Portal は credentials を書き換えない。
  access token が無い・失効・401 のときは `/usage` を 1 回だけ実行して更新し、同じ要求を 1 回だけやり直す。
  CLI の起動は通常の手動更新と同じ 60 秒の間隔に従い、cooldown 中は起動せずに読み直しだけで判断する。
- 取得は画面のメニュー「リセット枠を取得」からだけ行う。周期取得にも、画面を開いたときの `/usage` にも乗せない。
  通常の `/usage` と同時に走らせないよう、Claude の取得と同じ single-flight に直列化する。
- 認証は `Authorization: Bearer <access>` と `anthropic-beta: oauth-2025-04-20`。`?cedar_ember=1` を付けないと
  `cedar_ember` は `null` で返る。
- `grants[]` のうち `resets_left > 0` かつ `ends_at > now` を採用する。回数は `resets_left` の合計、期限は
  `ends_at` を昇順で持つ。`weekly_resets_at` は週次窓のリセットなので混ぜない。期限の無い grant（`ends_at: null`）は
  今の表示モデルで表せないため対象外にする。
- 0 件とするのは `eligible: false` のときと、`grants[]` が空・未設定のときだけ。`cedar_ember` が null、
  行や `ends_at` の形が読めない応答（キーの欠落を含む）は、0 件ではなく取得失敗として扱う
  （前回の値を 0 件で上書きしない）。`label` などの自由文は保存・表示しない。
- `cedar_ember` の形が変わったら adapter を直す。
- 結果は `/usage` の snapshot とは別の 1 行（`claude_reset_credits`）に保存し、通常の更新で消えないようにする。
  取得失敗は前回の値を残して error だけを更新し、ログアウトで行ごと消す。

### 接続の判定とログアウト

- 接続の判定は `claude auth status`（JSON）で行う。`loggedIn: false` は `not_connected`、`authMethod` が
  `claude.ai` 以外は `subscription_required`、`loginExpiresAt` を過ぎていれば `reauth_required` とし、
  どれも `/usage` を起動しない。`/usage` はログイン前でもエラーにならずセッションのコスト統計を返すため、
  その出力で接続を判定しない。読むのは `loggedIn` / `authMethod` / `subscriptionType` / `loginExpiresAt` だけで、
  メールアドレスや組織の情報は保存・ログ・応答に出さない。
- `CLAUDE_CONFIG_DIR` は `CREDENTIAL_DIR/claude`（0700）にし、ホストの `~/.claude` とは共有しない。
- サインインは Web UI で中継しない。初回は端末から `docker exec -it <コンテナ> claude auth login` を実行し、
  未接続のカードには手順だけを出す。
- カードを出すかは `/api/usage` の `error` と `capturedAt` から導出する。`not_connected` と、取得前で error が無い
  状態は出さない。非表示はログアウトにする。カードの「ログアウトして非表示」から
  `POST /api/claude/logout` を呼び、サーバーは `claude auth logout` を CLI で実行してから snapshot と error を消す。
  資格情報は CLI が破棄し、アプリは読まない。sample は残す。
- ログアウトは取得を待たない。`ClaudeUsageService` に世代番号と `loggingOut` を持ち、進行中の attempt は
  保存直前に世代を照合する。`loggingOut` 中の refresh は CLI を起動しない。logout の応答は CLI の 15 秒の期限に収める。
- ログアウトで sample は残るため、再ログイン後の推移に以前の履歴が混ざる。
- `authMethod` が `api_key_helper` など設定ファイル由来の場合、`claude auth logout` では消えず、カードが戻り得る。
  その場合は `CLAUDE_CONFIG_DIR` の設定から API キーの指定を外す手順を出す。非表示フラグは追加しない。

### 開始予約

- 入力は「必ずリセットさせる時刻」、「1 日の回数」（1〜4）、「空ける時間」、曜日。時刻は保存時のブラウザの IANA
  タイムゾーン付きで持つ。CLI は `TZ=UTC` のまま動かす。
- 24 時間は 5 で割り切れないため、余りの時間は窓を開始しない「空き」として 1 日に 1 か所に置く。空きのあとの
  最初の開始から 5 時間おきに回数ぶん開始し、翌日は同じ時刻から回る。空きの間に Claude を使うと、そこで窓が始まり、
  次の枠の開始が見送りになることがある。
- モデルと思考レベルはコードに既定値を置かず、選んで保存するまで予約を有効にできない。モデルは CLI の別名
  （`haiku` / `sonnet` / `opus`）、思考レベルは `low` / `medium` / `high` から選ぶ。
- 1 枠の実行:
  1. 送信前に `/usage` を読む。rolling 窓が動いていなければ送信する。窓が動いていて、リセットが枠の時刻から
     30 分以内なら、リセットの直後まで待ってやり直す（待つ先は、前の窓をこのアプリが開始したときの送信時刻の
     5 時間 15 秒後。自分で開始していない場合だけ `/usage` のリセット時刻の 2 分後）。それより後なら見送り。
     週次が 100% なら見送り。
  2. 固定の 1 行プロンプトを送る。上限は 60 秒（推論を伴うため、`/usage` の 15 秒とは分ける）。成否は exit code と
     JSON の `is_error` で判定し、`result` の本文は保存もログ出力もしない。
  3. 成功したら `/usage` を読み直し、snapshot を保存する。リセット時刻は履歴にも残す。
  4. サーバーが止まっていて枠の時刻を過ぎた場合は、30 分以内なら遅れて実行し、それより遅ければ見送りとして記録する。
- 失敗は固定のコードへ丸める。送信前の確認で出たエラーは既存の `ProviderErrorCode` を使う。送信の失敗は
  `api_error_status` で分け、401 / 403 が `reauth_required`、429 が `limit_reached`、400 / 404 が
  `model_unavailable`、期限超過が `timeout`、それ以外が `unavailable`。
- 429 は失敗ではなく「見送り（上限）」として記録し、連続失敗に数えない。予約の実行が 3 回続けて失敗したら
  自動開始をオフにして理由を残す。見送りは失敗に数えず、成功で連続失敗を 0 に戻す。再開はスイッチをオンに戻す操作。
- ログアウトしたら予約を無効にする。
- 設定と状態（オン / オフ・連続失敗の数・停止の理由・最後に送った時刻）は SQLite の `claude_start` に 1 行で置く。
  履歴は `claude_start_run` に置き、sample と同じ 30 日で消す。schema は v3。
- 同じ枠を 2 回送らないよう、処理済みの枠を履歴に残す。サーバーを止めていた間の枠は、再起動後に 30 分以内なら送り、
  それより遅ければ最後に過ぎた枠だけを見送りとして 1 行残す（曜日を 1 つだけ選んだときの間隔に合わせ、8 日までさかのぼる）。
- 予約をオンにした・設定を保存した時刻を `claude_start` に残し、それより前の枠は再起動をまたいでも送らない。
- プロンプトとシステムプロンプトは毎回同じ固定文にする。時刻などの可変値は足さない。

## 採用しない案

- 5 分周期の sampler: 画面を見ていない間も、推論を伴わない機械的な呼び出しが 1 日 288 回続く。規約上の扱いが
  不透明なまま、アカウントを失うリスクに見合わない。
- `GET /api/usage` で古ければその場で取る: client は 60 秒ごとにこの API を呼ぶので、開きっぱなしの画面が取得を
  起こし続ける。契機を「開いた」「手動」に絞れない。
- 画面を開いている間だけ 15 分ごとに取る: 開きっぱなしの端末で 1 日 96 回になり、周期取得と性質が変わらない。
- OAuth のアクセストークンを取り出して `/api/oauth/usage` を直接叩く: 資格情報をこのアプリのコードが扱うことになり、
  規約の「収集・保存・仲介」に近づく。
- Web UI でサインインの URL とコードを受け渡す: サインインは Anthropic 自身のフローで完結させる必要があり、
  中継が許されるかを断言できない。
- `claude setup-token` の長期トークン: `user:profile` を持たず、利用枠が返らない見込み。
- 非表示フラグを DB / localStorage に持つ: 再ログインを検知する契機が別に要り、端末ごとに状態がずれる。
- カードを消すだけでログアウトしない: 資格情報が残り、次の `auth status` が未接続を返せば結局カードが戻る。
- ログアウトの完了を待ってから取得を止める: CLI が 2 回続き、応答が最大 30 秒になる。

## 影響

- 画面を見ていない間は更新されない。sample は画面を開いた時刻にだけ増え、推移に欠けが出る。
- `stale` は取得から 15 分を超えたときに切り替える。`decideProviderState` は provider ごとの閾値を受け取る。
- 出力は公開契約ではない。文面が変わったら `schema` エラーになる。fixture を年付きの出力まで含めて固定する。
- image は CLI のぶん大きくなる。ログインには期限（`loginExpiresAt`、約 30 日）がある。
- 規約の解釈は変わり得る。公式 CLI を未改変で使い、自分のアカウントだけを対象にする前提が崩れる変更（共有、
  複数アカウント、バイナリの改変、トークンの直接利用）は、この決定を見直してから行う。
- `auth status` が実行時にネットワークへ出るかは未確認。出るなら取得の前段に置く設計を見直す。
