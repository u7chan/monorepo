# AGENTS.md

モノレポの `projects/usage-portal`。リポジトリ共通の規約は [ルートの AGENTS.md](../../AGENTS.md) を参照する。

Codex と OpenCode Go の利用枠を 1 ページで見る読み取り専用ダッシュボード。自宅 LAN または VPN の内側で動かす。

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
- OpenCode Go の API キーは `src/server/opencode/` が `CREDENTIAL_DIR` の `opencode-key.json` に保存し、`/api/opencode/*` から登録・解除する。`.env` は使わない（[docs/adr/0006-opencode-api-key-registration.md](docs/adr/0006-opencode-api-key-registration.md)）。
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
- Codex のサインインは SDK を差し替えた状態機械としてテストする（`select` / `manual_code` / 中断 / 10 分の期限 / 生の文言を返さないこと）。
- DOM テストは書かない。見た目はブラウザで確認する。
- lint と typecheck が保証する内容を unit test で重複して固定しない。

## コメント

長い設計論は `docs/` へ移し、コメントは 1〜2 行に収める。何を書くかは [ルートの AGENTS.md](../../AGENTS.md) に従う（コードは `Why not`、テストは `What`）。Issue / PR 番号はコメントに残さない。

## docs

- [README.md](README.md) — 起動方法、環境変数、Docker、セキュリティの前提
- [docs/design.md](docs/design.md) — 設計（親 checkout からの写し）
- [docs/adr/](docs/adr) — スタック、状態取得、認証と公開範囲、利用枠の保存、Codex のサインイン、OpenCode Go のキー登録の決定
