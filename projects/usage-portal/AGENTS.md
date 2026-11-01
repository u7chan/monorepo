# AGENTS.md

モノレポの `projects/usage-portal`。リポジトリ共通の規約は [ルートの AGENTS.md](../../AGENTS.md) を参照する。

Codex と OpenCode Go の利用枠を 1 ページで見るダッシュボード。自宅 LAN または VPN の内側で動かす。
利用枠の表示に加えて、設定したときだけ固定の最小プロンプトを 1 回送る操作（Codex の 5 時間窓の開始と
OpenCode Go の接続確認）を持つ。

## Tech Stack

- Bun 1.3（runtime / package manager / bundler / test）
- TypeScript（strict）+ Preact 11（client）
- Hono（BFF）。`AppType` を server 側の型の正として export する
- `bun:sqlite`（ORM なし）
- 素の CSS（`--up-` 接頭辞の CSS 変数）
- oxlint / oxfmt / tsc / bun:test

## 構成

- `src/server.ts` が `Bun.serve` の入口。`index.html` の HTML import を `/` に、それ以外を Hono に渡す。SQLite・sampler・Codex の資格情報はここで組み立てる。
- `src/server/app.ts` が API の Hono app。認証・利用枠・Codex のサービスは依存として注入し、テストは `app.request()` で叩く。
- 認証状態は環境変数ではなく `DATA_DIR` 配下のファイル（`pin-hash` / `session-key`）に持つ。理由は [docs/adr/0003-pin-storage-and-session-key.md](docs/adr/0003-pin-storage-and-session-key.md)。
- 利用枠は `src/server/providers/` の adapter で `ProviderSnapshot` に正規化し、`src/server/sampler.ts` が 5 分ごとに取得して `src/server/db.ts` へ書く。応答は `src/server/usage.ts` が組み立てる（[docs/adr/0004-usage-sampling-and-storage.md](docs/adr/0004-usage-sampling-and-storage.md)）。
- Codex の資格情報とサインインは `src/server/codex/`。OAuth は実装せず、Pi SDK の `ModelRuntime` を認証の境界としてだけ使う（[docs/adr/0005-codex-credentials-and-sign-in.md](docs/adr/0005-codex-credentials-and-sign-in.md)）。
- OpenCode Go のアカウント（名前 / アイコン / API キー）は `src/server/opencode/accounts.ts` が `CREDENTIAL_DIR` の `opencode-accounts.json` に保存し、`/api/opencode/accounts` から登録・変更・削除する。入力規則は `src/shared/opencode-account.ts` を server と client で共有する。`.env` は使わない（[docs/adr/0006-opencode-api-key-registration.md](docs/adr/0006-opencode-api-key-registration.md), [docs/adr/0007-opencode-multiple-accounts.md](docs/adr/0007-opencode-multiple-accounts.md)）。
- DB の `provider` 列は provider id ではなく source id（`codex`（未接続時）/ `codex:<chatgpt account id>` / `opencode-go:<account uuid>`）を持つ。テーブル定義と `user_version` は v1 のまま（ADR 0007, 0018）。Codex のサインアウトは snapshot と error だけを消し、sample は同じアカウントの再サインイン用に残す。
- 送信（5 時間窓の開始・接続確認）は `src/server/probe/`。エージェントは使わず、`@earendil-works/pi-ai` の
  `openaiCodexProvider()` / `opencodeGoProvider()` を直接呼ぶ。Codex の access token は `CodexAuth.credential()`
  から取り、`auth.json` は解析しない（[docs/adr/0017-probe-prompts.md](docs/adr/0017-probe-prompts.md)）。
  認証の境界は ADR 0005 のままなので、`ModelRuntime` は資格情報とサインインにだけ使う。
- 送信で扱うのは status・`stopReason`・latency・固定のエラーコードだけ。プロンプトはサーバ側の固定 1 文で、
  応答本文・上流のエラー文は保存もログもせず、クライアントにも返さない。
- `@earendil-works/pi-*` は u7agent と同じバージョンに固定する。マイナーでも破壊変更が入るため、Dependabot の自動更新には乗せず、migration とセットで手動更新する。
- client は `src/client/api.ts` で API を呼ぶ。`hc` は validator を入れるまで request body の型を共有できないため使わない（ADR 0003）。状態管理・UI コンポーネント・日付整形のライブラリは足さない（[docs/adr/0000-stack-and-style.md](docs/adr/0000-stack-and-style.md)）。
- `docs/design.md` は親 checkout の写し。このプロジェクトでは書き換えない。決定と背景は `docs/adr/` に足す。

## 検証

`bun run check`（lint → fmt:check → typecheck → test → docs:check）を実行する。
Docker は `docker build --target test -t usage-portal-test ./projects/usage-portal`、ライセンスはリポジトリ root から `./scripts/check-licenses --target projects/usage-portal`。

- `docs:check` は README / AGENTS.md / docs の相対リンクとリポジトリ内パスを実ファイルと突き合わせる。`docs/design.md` は写しのため対象外。
- 環境変数を足したら `.env.example` と README の表を同じ PR で直す。コードが読まない変数を先に書かない。
- 意図的に残す lint 違反は理由コメント付きで disable する。

## テスト方針

ユーザーから見た振る舞いが同じなら、実装方法を変えてもテストが通る形にする。

- 純関数（整形、判定、環境変数の検証）と BFF の契約（status、body、ヘッダー）を自動テストする。
- SQLite と認証状態のファイルは一時ディレクトリに本物を作り、DDL、`user_version`、権限、排他を確認する。モックの DB は使わない。
- provider の adapter は上流の応答を `unknown` として直接渡し、窓の欠損・0%・100 超・schema 変化を固定する。ネットワークは叩かない。
- 送信の契約は、`streamSimple` だけを差し替えた偽 provider と偽 `fetch` で固定する（status の丸め・stream の終端・
  single-flight・timeout 後の解放・kick の有無）。実資格情報は使わない。
- Codex のサインインは SDK を差し替えた状態機械としてテストする（`select` / `manual_code` / 中断 / 10 分の期限 / 生の文言を返さないこと）。
- DOM テストは書かない。見た目はブラウザで確認する。
- lint と typecheck が保証する内容を unit test で重複して固定しない。

## コメント

長い設計論は `docs/` へ移し、コメントは 1〜2 行に収める。何を書くかは [ルートの AGENTS.md](../../AGENTS.md) に従う（コードは `Why not`、テストは `What`）。Issue / PR 番号はコメントに残さない。

## docs

- [README.md](README.md) — 起動方法、環境変数、Docker、セキュリティの前提
- [docs/design.md](docs/design.md) — 設計（親 checkout からの写し）
- [docs/adr/](docs/adr) — スタック、状態取得、認証と公開範囲、利用枠の保存、Codex のサインイン、OpenCode Go のアカウント、残量表示と推移の期間、窓の停止表示とメニュー、表示の密度、Codex のサインアウト、ゲージの印、リセット行のバッジ、使い切ったカードの並び、最小プロンプトの送信、Codex の推移の引き継ぎの決定
