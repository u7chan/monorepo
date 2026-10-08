# AGENTS.md

モノレポの `projects/u7agent`（既存の `projects/aiagent` とは別物）。リポジトリ共通の規約は [ルートの AGENTS.md](../../AGENTS.md) を参照する。

pi SDK を BFF に埋め込んだ小さなブラウザ GUI。

## Tech Stack

- Node.js 24 / pnpm 10.34.5
- TypeScript / Hono / zod（`server/` の BFF）
- pi SDK（`@earendil-works/pi-coding-agent`）
- Vite / React 19 / Tailwind CSS v4（`client/`）

## 構成

- client は `hono/client`（hc）で server の `AppType` を参照し、型安全に API を呼ぶ。
- セッションと会話履歴は BFF 専用の会話ストア（`PI_SESSION_STORE`）へ保存し、再起動後も復元する。
- エージェント / スキル定義とプロジェクトはアプリデータの SQLite（`<PI_SESSION_STORE>/u7agent.db`）へ保存され、再起動後も残る。
- 作業用ツールはサンドボックス（別プロセス / 別コンテナ）へ分離済み。BFF は子プロセスを起こさない。

## 検証

実装したら `pnpm check`（lint → format:check → docs:check → 型チェック → テスト → クライアントビルド）を実行する。設定と落とし穴は [docs/verification.md](docs/verification.md) を参照する。

- 意図的に残す lint 違反は理由コメント付きで disable する（`// oxlint-disable-next-line <rule> -- 理由`）。
- コンポーネントは見た目を自分で持ち、呼び出し側の `className` は layout だけにする。見た目の切替は呼び出し側のクラスではなく props で行う。
- クラス文字列は `className` / クラス属性 / `cn(...)` / `@apply` から辿れる位置にだけ置き、実行時に組み立てるときは `client/src/lib/cn.ts` の `cn(...)` に通す。

## テスト方針

実装方法を変えてもユーザーから見た仕様が同じなら、テストはそのまま通る設計を優先する。

- pure logic、state transition、API、永続化、security boundary、retry / timeout / queue と重要な操作・アクセシビリティ契約は自動テストする。
- TSX / CSS を `readFileSync` して class 名・関数名・コード断片の存在を検査するテストは原則追加しない。例外は型で保証できない安全性・複数形式間の契約に限定し、理由と検査範囲を明記する。
- lint / typecheck が保証する内容を unit test で重複して固定しない。
- CSS animation、spacing、色、translate、duration 等の視覚調整は原則として自動テストしない。CSS 値を入力にする parser / fallback ロジックは別で、自動テストする。
- 過去バグも修正方法ではなく観測できる不具合を検証する。DOM が必要なら source scan で代用せず、ブラウザで確認する。
- GUI の短時間で確認できる見た目は手動受入でよい。最小チェックと既存テストの分類は [docs/testing.md](docs/testing.md) を参照する。

## コメント

長い設計論は `docs/` へ移し、コメントは1〜2行に収める。何を書くかは [ルートの AGENTS.md](../../AGENTS.md) に従う。同じ理由をコードと `docs/` に二重に書かない（どちらに置くかは [docs](#docs) 節の「読み手の範囲」で決める）。Issue / PR 番号はコメントに残さない（経緯は git 履歴と PR が持つ）。

## docs

**状態の正はコードとテスト。理由の置き場は読み手の範囲で決める。** その module の読み手だけが要る理由はそのコードのコメントへ（1〜2 行）。他の module の読み手も要る理由と、コメントに収まらない長い理由は `docs/` へ。どちらか一方にだけ置く。

状態の一覧・件数・並び・既定値・計測値はコード / テストから読めるので `docs/` へ書かない（書くなら「正は `client/src/lib/` の該当 module」とだけ書く）。`docs/` に書くのは次だけ。

- 利用者から見た振る舞いが変わらない変更では書き換えが要らない文（モジュールをまたぐ契約、採用しなかった案、既知の制限、非ゴール）
- コードのコメントに収まらない長さの理由
- 変更テーマから読むコードを引く索引（[docs/README.md](docs/README.md)）

判定式は「**利用者から見た振る舞いが変わらない変更で書き換えが要るか**」。要るなら `docs/` に書かない（class 名・関数名・ファイル名・ぴったり値・実測値・文言の写し・一覧の写しがこれに当たる）。

- 相互参照は安定した識別子（URL `/settings/<section>`、ファイルパス、section id）で書く。ラベルは UI で最も動く部分なので、人間向けの導線として使うときはそのファイルでの初出に URL を併記する（例: `設定 → ダウンロード（/settings/archive）`）。
- 実測値（特定の viewport / ブラウザーでの数値）は書かない。PR の Verification と GUI 受入に残す。
- 機械的に検出できる腐り（相対リンク / `#anchor` / リポジトリ内パスの不在、ソースのコメントからの docs 参照、フロント docs の行数予算）は `pnpm docs:check` が検査する。予算を上げるときは diff に出してレビューで合意する。

## 参照

- [docs/](docs) — 設計と API の詳細。入口は [docs/README.md](docs/README.md) の変更テーマ別索引。必要なテーマのドキュメントだけを辿る。
- [README.md](README.md) — 人間向け（起動方法・環境変数・セキュリティ）。エージェントが読むのは最終手段にする。
