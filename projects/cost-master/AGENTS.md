# AGENTS.md

モノレポの `projects/cost-master`。リポジトリ共通の規約は [ルートの AGENTS.md](../../AGENTS.md) を参照する。

コンテンツ生成モデルの価格と「一覧に出す / 出さない」の判断を返すサービス。自宅 LAN または VPN の内側で
動かし、u7agent から手動の [カタログ更新] のときだけ読む。読み取りの API と、判断を 1 行だけ変える更新、
マスタを置き換えるアップロードを持ち、DB と認証は持たない。

## Tech Stack

- Bun 1.4（runtime / package manager / bundler / test）
- TypeScript（strict）+ Preact 11（client）
- Hono（BFF）
- 素の CSS（`--cm-` 接頭辞の CSS 変数。値と使い分けは [DESIGN.md](DESIGN.md)）
- oxlint / oxfmt / tsc / bun:test

## 構成

- `src/server.ts` が `Bun.serve` の入口。`index.html` の HTML import を `/` に、それ以外を Hono に渡す。マスタの置き場（`MASTER_DIR`）を用意して `master-store` を組み立てる。
- `src/server/app.ts` が API の Hono app。`/api/models` / `/api/health`（読み取り）、`/api/master/:kind`（ダウンロード / アップロード）、`/api/judgments`（1 行だけの更新）を持つ。状態は依存として注入し、テストは `app.request()` で叩く。書き込みは same-origin だけ通し、認証は持たない（LAN / VPN の内側という前提を変えない）。
- `src/server/master.ts` がマスタの検証・正規化・応答の組み立て。純関数だけを置く。壊れた行は落とし、どちらかのファイルが読めないときは 503 に倒す（空の一覧を返して価格と判断を消さない）。1 行の更新計画（`planJudgment`）もここに置く。
- `src/server/master-store.ts` が `MASTER_DIR` の読み書き。起動時に volume にマスタが 1 つも無ければ image 同梱の初期値をコピーし（片方だけあるときはコピーしない）、リクエストごとに mtime を見て読み直す（再起動なしで反映）。読めないときは理由（`failure`）と落とした行数を持たせ、`/api/health` に出す（ログを見なくても原因に辿り着けるようにする）。置き換えは 1 行でも不正なら全体を拒否し、tmp + rename で置き換えて直前の内容を `.bak` に残す。
- `src/server/generate.ts` が価格の取り込み。上流の取得も同じ関数に閉じ、`fetch` を注入できる。失敗したモデルは前回の行を残し、`endpoints: []` は価格なしを確定する。上流の応答本文はログにもファイルにも出さない。**サーバーは上流へ出ない**（取り込みは手元で実行し、結果をアップロードする）。
- `src/shared/contract.ts` が応答の型の正。u7agent 側の DTO とは別で、`billable` はここまで。
- `src/shared/format.ts` が単価と鮮度の整形。client とスクリプトの出力で共有する。

## マスタの 2 ファイル

| ファイル | 由来 | 触り方 |
| --- | --- | --- |
| `src/server/data/prices.json` | endpoints API から機械生成 | 手で編集しない（`bun run generate`） |
| `src/server/data/enabled.json` | 人の判断とメモ | 画面のスイッチ（一括・復旧はダウンロードして編集） |

由来を混ぜないのは、生成が人の判断を上書きしないようにするため。判断が無いモデルは `enabled: true`。

## 検証

`bun run check`（lint → fmt:check → typecheck → test → docs:check）を実行する。
Docker は `docker build --target test -t cost-master-test ./projects/cost-master`、ライセンスはリポジトリ root から `./scripts/check-licenses --target projects/cost-master`。

- `docs:check` は README / AGENTS.md / DESIGN.md / docs の相対リンクとリポジトリ内パスを実ファイルと突き合わせる。
- 環境変数を足したら [.env.example](.env.example) と README の表を同じ PR で直す。コードが読まない変数を先に書かない。

## テスト方針

ユーザーから見た振る舞いが同じなら、実装方法を変えてもテストが通る形にする。

- マスタの検証・マージ・応答の組み立ては純関数として、落とす行と既定値を固定する。1 行の更新（`planJudgment`）は、行の追加・反転・`note` の保持・no-op を固定する。
- 置き場（seed のコピー・mtime での読み直し・`.bak`・不正入力の拒否）と、書き込み API（same-origin / 上限 / 反映 / no-op で書かないこと）を一時ディレクトリと `app.request()` で固定する。
- 取り込みは `fetch` を差し替え、上流の形の変化（出力以外・未知 unit・空 pricing・空 endpoints・失敗）を固定する。ネットワークは叩かない。
- API は `app.request()` で status・body・ヘッダーを固定する。
- 純関数（整形、グループ化、環境変数の検証）を自動テストする。DOM テストは書かず、見た目はブラウザで確認する。

## コメント

長い設計論は [docs/adr/](docs/adr) へ移し、コメントは 1〜2 行に収める。何を書くかは [ルートの AGENTS.md](../../AGENTS.md) に従う（コードは `Why not`、テストは `What`）。Issue / PR 番号はコメントに残さない。

## docs

- [README.md](README.md) — 起動方法、API、マスタのメンテ、Docker、セキュリティの前提
- [DESIGN.md](DESIGN.md) — 画面の色・文字・部品・動きの正。`src/client/styles.css` を変えたら同じ PR で直す
- [docs/adr/0000-read-only-master-service.md](docs/adr/0000-read-only-master-service.md) — 別サービスにする理由、マスタ 2 ファイル、最大単価、enabled の既定
