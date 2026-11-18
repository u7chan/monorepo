# ADR 0022: Claude の利用枠を公式 CLI の `/usage` で、画面を開いたときと手動更新だけ取る

- Status: accepted
- Date: 2026-11-18

実装は後続の PR で行う。この ADR だけでは画面に Claude は増えない。

## 背景

Claude の Pro / Max の利用枠（5 時間・週次）をダッシュボードに足したい。取得経路は次のとおり。

- Usage and Cost Analytics API（`/v1/organizations/analytics/usage`・`/cost`）は、Console / Enterprise 組織のトークン数と
  コストの集計で、Admin API の認証が要る。Team プランと個人の Console アカウントは対象外で、データは通常 4 時間、
  最大 24 時間遅れる。サブスクリプションの窓の残りは返さない。
- 公式 CLI の `claude -p "/usage"` は、窓ごとの使用率とリセット時刻を返す。内部では非公開の `GET /api/oauth/usage` を
  読む。モデルは呼ばず、CLI の計上は `num_turns: 0`・トークン 0・コスト 0 になる。
- Claude Code の Legal and compliance は、OAuth を通常の利用向けとし、Claude.ai の資格情報やセッショントークンを
  第三者のアプリが収集・保存・仲介することを認めない。一方、改変していない Claude Code に、利用者が自分の
  サブスクリプションでサインインすることは妨げない。違反への措置は事前通知なしに取られ得る。機械的な呼び出しの
  検知基準は公開されていない。

Codex と OpenCode Go は 5 分ごとにバックグラウンドで取る（ADR 0004）。Claude は、アカウントを失う影響が大きいので
同じ周期では取らない。このポータルは PIN 認証・LAN 内・自分 1 人専用で、第三者に Claude を提供しない。

## 決定

取得の契機:

- 周期の sampler には乗せない。取るのは次の 2 つだけにする。
  - 画面を開いたとき（初回表示と、タブが見える状態へ戻ったとき）。前回の取得から 15 分以内なら CLI を起動せず、
    保存済みの値を使う。
  - Claude カードの `⋮` メニューの「更新」。15 分の制限は受けないが、前回の試行から 60 秒は空ける。
    Codex と OpenCode Go のカードには足さない。
- 画面を開いている間の定期取得はしない。取得から 15 分を超えた値は `stale` として出し、更新は手動にする。
- 取得は認証必須・同一 origin 検査つきの `POST /api/claude/refresh`。`GET /api/usage` は今までどおり SQLite を
  読むだけで、上流へ取りに行かない。同時要求は single-flight、CLI のタイムアウトは 15 秒で、超えたら kill する。
- 失敗しても自動では再試行しない。次に取るのは、15 分後以降に画面を開いたときか手動更新。

取得方法:

- 公式 `claude` を子プロセスとして起動し、`claude -p "/usage" --output-format json --no-session-persistence` の
  `result`（文字列）を読む。トークンを取り出して API を直接叩かない。`.credentials.json` も読まない。
- 子プロセスには `PATH` / `HOME` / `CLAUDE_CONFIG_DIR` / `TZ=UTC` だけを渡し、cwd は空の一時ディレクトリにする。
- `Current session` を rolling（18000 秒）、`Current week (all models)` を weekly（604800 秒）の窓にする。
  `N% used` と `resets <日時> (<IANA タイムゾーン>)` を読む。日時は通常 `Nov 19, 12:50am`（分が 0 なら `6am`）の
  ように年が無く、リセットが翌年に落ちるとき（年末の週次など）だけ `Jan 2, 2027, 3am` のように年が付く。
  CLI はリセットの年が今年と違うときに年を足すため。年が無ければ括弧内のタイムゾーンで解釈して、今より後で
  最も近い日時を採り、年があればその年を使う。年と時刻の区切りは `, ` と ` at ` のどちらも受ける。
- 認識できる行だけを窓にする。1 つも読めなければ `schema` エラー。モデル別の窓などは Max の出力を確認してから足す。
- 正規化した `ProviderSnapshot`（`provider: "claude"`、source id は `claude` 固定、plan は `subscriptionType`）と
  sample だけを既存のテーブルへ保存する。CLI の出力本文は DB・ログ・応答に残さない。

接続の判定とサインイン:

- 接続の判定は `claude auth status`（JSON）で行う。`loggedIn: false` は `not_connected`、`authMethod` が
  `claude.ai` 以外は `subscription_required`、`loginExpiresAt` を過ぎていれば `reauth_required` とし、
  どれも `/usage` を起動しない。`/usage` はログイン前でもエラーにならず、セッションのコスト統計を返すため、
  その出力で接続を判定しない。読むのは `loggedIn` / `authMethod` / `subscriptionType` / `loginExpiresAt` だけで、
  メールアドレスや組織の情報は保存・ログ・応答に出さない。
- `CLAUDE_CONFIG_DIR` は `CREDENTIAL_DIR/claude`（0700）にし、ホストの `~/.claude` とは共有しない（ADR 0005 と同じ理由）。
- サインインは Web UI で中継しない。初回は端末から `docker exec -it <コンテナ> claude auth login` を実行し、
  未接続のカードには手順だけを出す。
- 公式バイナリは改変せずに image へ入れ、自動更新は止めてバージョンを固定する。入れ方は実装 PR で決める。
- Claude へプロンプトは送らない。5 時間窓の開始も接続確認もしない（ADR 0017 の対象外）。

## 採用しない案

- 5 分周期の sampler: 画面を見ていない間も、推論を伴わない機械的な呼び出しが 1 日 288 回続く。規約上の扱いが
  不透明なまま、アカウントを失うリスクに見合わない。
- `GET /api/usage` で古ければその場で取る: client は 60 秒ごとにこの API を呼ぶので、開きっぱなしの画面が取得を起こし
  続ける。契機を「開いた」「手動」に絞れない。
- 画面を開いている間だけ 15 分ごとに取る: 開きっぱなしの端末で 1 日 96 回になり、周期取得と性質が変わらない。
- OAuth のアクセストークンを取り出して `/api/oauth/usage` を直接叩く: 構造化された JSON が取れるが、資格情報を
  このアプリのコードが扱うことになり、規約の「収集・保存・仲介」に近づく。
- Web UI でサインインの URL とコードを受け渡す: サインインは Anthropic 自身のフローで完結させる必要があり、
  中継が許されるかを断言できない。端末で 1 回行えば済む。
- Usage and Cost Analytics API: この環境のサブスクリプションでは使えず、窓の残りも返さない。
- `claude setup-token` の長期トークン: `user:profile` を持たず、利用枠が返らない見込み。`--bare` は OAuth を
  読まないため、どちらも `/usage` の取得には使わない。
- statusline の `rate_limits`: 構造化されているが、対話セッションの中でしか届かない。

## 影響

- 画面を見ていない間は更新されない。sample は画面を開いた時刻にだけ増え、推移に欠けが出る。欠けのつなぎ方は実装 PR で決める。
- `stale` は取得から 15 分を超えたときに切り替える（決定と同じ 15 分）。`decideProviderState` は
  `2 * sampleIntervalMs` 固定をやめ、provider ごとの閾値を受け取る。Codex と OpenCode Go は今までどおり
  周期の 2 倍（10 分）にする。
- 出力は公開契約ではない。文面が変わったら `schema` エラーになる。adapter は、年が付く出力（年末）を含めた fixture で固定し、CLI の版を上げるときに差分を見る。
- image は CLI のぶん大きくなる（ホストで見た版の実体は約 370 MB）。
- ログインには期限（`loginExpiresAt`、約 30 日）がある。使うたびに延びるかは未確認で、切れたら端末で再ログインする。
- `claude auth status` がネットワークへ出るかは未確認。出るなら、取得の前段に置く設計を見直す。
- 規約の解釈は変わり得る。公式 CLI を未改変で使い、自分のアカウントだけを対象にする前提が崩れる変更（共有、
  複数アカウント、バイナリの改変、トークンの直接利用）は、この ADR を見直してから行う。
- Codex と OpenCode Go の周期取得、ADR 0004 は変えない。Claude だけ取得の経路が別になる。

## 実装時に確認したこと（CLI 2.1.327）

実装 PR で、版固定した公式バイナリ（2.1.327）の中の生成コードを読んで確かめた事実。実機での実行結果ではない。

- `claude auth status` は既定で JSON を返す（`--json` は既定、`--text` で別文面）。項目は `loggedIn` / `authMethod` /
  `apiProvider` / `loginExpiresAt` などで、`authMethod` は `claude.ai` / `api_key` / `api_key_helper` / `oauth_token` /
  `third_party` / `none` を取る。`loginExpiresAt` は ISO 8601 の文字列（または `null`）で、`subscriptionType` は
  `authMethod` が `claude.ai` のときだけ入る。
- 自動と手動の区別は `POST /api/claude/refresh` の body で受け取る。画面以外の要求が `manual` を名乗っても、
  60 秒の下限と single-flight は効くが、15 分の窓は明示操作として越えられる（1 人用の LAN 内アプリなので許容する）。
- `/usage` の `result` は、前文のあとに 1 窓 1 行を並べる。行は
  `Current session: 12% used · resets Nov 19, 12:50am (America/Los_Angeles)` の形で、率は切り捨ての整数、
  区切りは ` · resets `。括弧内は CLI プロセスのローカルなタイムゾーン名（`TZ=UTC` にすれば `UTC`）で、
  年はリセットの年が今年と違うときだけ付き、分が 0 なら時だけを出す。
- Max / Team では `Current week (Sonnet only)` と、モデルごとの `Current week (<モデル名>)` の行が加わる。
  決定どおり、いまは `Current session` と `Current week (all models)` の 2 窓だけを読む。
- CLI は `downloads.claude.ai` の版固定バイナリを、公式 manifest の checksum と突き合わせて入れられる。
  実行ユーザーが書き換えられない場所（root 所有の 0755）に置けば、自動更新が試されても版は変わらない。

未確認のまま残ること: `auth status` が実行時にネットワークへ出るか、ログイン期限が使うたびに延びるか、
コンテナ内で `claude auth login` した資格情報が再起動後も残るか、Max の実出力、推移の欠けのつなぎ方、
カードの並び順、自動更新の確認自体が走るか（置き換えはできないが、外部への更新確認の有無は未確認）。
