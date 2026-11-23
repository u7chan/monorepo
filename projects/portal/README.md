# Docker Container Portal

Bun + React + TypeScriptで構築された、Dockerコンテナを可視化・管理するWebポータルアプリケーション。

## 機能

- **ポートリンク**: 起動中のコンテナが公開しているポートを、カードごとの主役として表示。クリックで既定は `http://<PORTAL_HOST>:PORT` を新しいタブで開く。Docker ラベルの `portal.url` / `portal.url.<公開ポート>` があるコンテナは、その URL をホスト名と鍵アイコンで表示する
- **コンテナ一覧表示**: ホスト上の全Dockerコンテナをカード / リストで表示（portal 自身のコンテナは除く）。リストは 1 つの面にまとめた行で、広い画面では名前・リンク・操作が 1 行に揃う。リンクを出さないコンテナ（`portal.hidden` / ポート未公開）は一覧の末尾にまとめる
- **ステータス表示**: 実行中/停止中などの状態を、色と Docker の状態文言の両方で表示
- **イメージ名のコピー**: カード/リストのコピーボタンでイメージURIをクリップボードへコピー
- **起動 / 停止**: 停止は確認シート（狭い画面は下から、広い画面は中央）を経てから実行
- **フィルタリング**: 全て/実行中/停止中でフィルタ可能（件数付き）。狭い画面では親指の届く下端に浮かぶバーに置く
- **外観の切り替え**: 既定は端末のライト / ダークに従う（Auto）。設定シートの Light / Dark で上書きでき、選択はブラウザに保存する
- **自動更新**: 30秒ごとに自動リフレッシュ
- **PWA**: manifest と 192 / 512px のアイコン、iOS ホーム画面用の 180px アイコンを配信
- **イメージタグの切り替え**: monorepo の CD が GHCR に push したイメージだけ、タグを選んで再デプロイできる。デプロイは self-hosted-runner の `manual-deploy.yml` を起動する
- **新着イメージ**: 稼働中のイメージより新しいビルドが GHCR に届いているデプロイ対象のコンテナには、Deploy の隣に `New` を出す。比較できないとき（`latest` / digest 参照 / タグ一覧に無い / 対象外のイメージ）は何も出さない
- **モックデータモード**: Docker不要でUI開発・レイアウト確認が可能

## デザイン方針

この画面の仕事は「起動中のサービスを開く」ことなので、リンク（ポート / URL）を最大の要素として扱う。
Apple の Human Interface Guidelines を土台に、モバイルファーストで組んでいる。

- **親指の届く位置に操作を置く**: 狭い画面では、絞り込みを下端に浮かぶガラスのバーに置く。広い画面では同じ部品が上の行に戻る（DOM は 1 つで、見た目だけを切り替える）
- **色の役割を分ける**: アクセント色（インディゴ）は「押せる」だけに使う。状態は別の色（起動中 = 緑 / 停止 = 赤 / 一時停止 = 橙 / 再起動 = 青）で示し、必ず Docker の状態文言も添える
- **押せるものだけ点灯**: 起動中のコンテナのリンクだけをアクセント色のタイルにする。停止中のコンテナのポートは数字を見せるがリンクにはしない（押しても繋がらないため）
- **開く先の無いカードは末尾へ**: `portal.hidden` とポート未公開のコンテナはタイルを持たず、一覧の目的（ポートを開く）に対してノイズになる。リンクを出すコンテナの後ろにまとめ、同順位どうしは docker ps の順を保つ（状態を並び替えのキーにすると、30 秒ごとの更新でカードが動いて見失うため）
- **見切れを作らない**: コンテナ名とホスト名は省略せず折り返す（ホスト名はピリオドの直後で改行する）。イメージ名は 1 行に収めるが、レジストリ側から省略して、名前とタグを残す。行送りは文字スタイルの値を守り、固定の高さ + `leading-none` + `truncate` は組み合わせない（`g` や `p` の下端が切り落とされるため）
- **文字だけが拡大する**: 文字は rem（iOS の Dynamic Type「Large」の文字スタイル）で、端末やブラウザの文字サイズに追従する。余白と角丸は px 固定にして、拡大した文字の幅を余白に食わせない。大きい文字では、操作ボタンが名前の下へ縦に積まれる
- **押せる範囲は 44px**: ボタンの見た目は小さくても、押せる範囲は `hit-area` で 44px に広げる。ホバーできる端末にはホバー状態を、すべての端末に押下状態を付ける
- **破壊的操作は確認シート**: 停止とロールバックは、`window.confirm` ではなく、取り消しを独立したボタンにしたシートで確認する。タイトルに対象の名前を入れて、何を止めるのかを読み返せるようにする
- **外観は端末に従う**: 既定は Auto。HIG はアプリ独自の外観設定を勧めていないが、端末と別に選びたい場合のために設定シートから Light / Dark で上書きできる。上書きした人の分だけ保存する
- **補助情報は静かに**: イメージ名とコピーはカード下部に置き、ホバーできる端末ではホバー時のみコピーボタンを出す
- **新着は操作の隣に**: 新しいビルドがあることは Deploy の隣の小さな `New` で示す。情報の色 (`info`) を使い、押せるもの (`accent`) とは分ける
- **動きは目的のある所だけ**: セグメントのつまみ・シート・デプロイ欄の開閉・外観の切り替えに動きを付ける。「視差効果を減らす」設定では移動をやめてフェードだけにし、「透明度を下げる」設定ではガラスを不透明にする

配色・書体・余白は `src/index.css` の `@theme` にトークンとして定義している。色は `light-dark(ライト, ダーク)` の 1 行にまとめ、`<html data-theme>` で上書きする。

| トークン                                       | 役割                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `canvas` / `surface` / `surface-2` / `sheet`   | 面（ページ背景 → カード → カード内の入れ子 / シート）             |
| `label` / `label-2` / `label-3`                | 文字（`label-3` は装飾専用で、読ませる文字には使わない）          |
| `accent` / `accent-fill` / `accent-wash`       | 押せるもの（文字 / 塗りボタン / タイルの背景）                    |
| `live` / `warn` / `dead` / `info`              | コンテナの状態と新着の印（ライトは白地で 4.5:1 以上になる濃い側） |
| `fill` / `fill-strong` / `separator` / `glass` | コントロールの面・押下・境界線・ナビバーとツールバーのガラス      |

文字色はライト / ダークとも、置かれる面に対して 4.5:1 以上になるよう計算で確認している。

## portal 自身の除外

portal 自身が一覧に出ると、開いても portal に戻るだけの項目が並ぶ。そのため、次のいずれかに当たるコンテナは一覧から除く。

- イメージのリポジトリが `ghcr.io/u7chan/monorepo/portal`（タグ・ダイジェストは問わない）
- `HOSTNAME` が自分のコンテナ ID と一致する（docker がコンテナのホスト名に短縮コンテナ ID を入れるため）

除外は `fetchContainers` が Docker から取得した時点で行う。このため一覧 API の件数は除外後になり、操作 API（`/api/containers/:id/:action`）も同じ経路で portal 自身を見つけられず、`start` / `stop` は 404 を返す。portal が自分自身を停止して画面ごと消えるのを避けるための挙動なので、この 404 は仕様とする。

## リンクのラベル

カード中央のリンクは既定で `http://<PORTAL_HOST>:<公開ポート>` になる。TLS 終端などでホスト名とポートだけでは行き先を表せないサービスは、Docker ラベルで上書きする。

| ラベル                                         | 用途                                | 表示                                                                                            |
| ---------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `portal.url: https://dozzle.home.arpa`         | 単一の入口                          | ホスト名 + 鍵のチップを 1 本だけ出す。公開ポートのタイルは出さないため、`ports:` を閉じても残る |
| `portal.url.<ポート>: https://agent.home.arpa` | 複数オリジン（u7agent の 3 面など） | 該当ポートのチップをホスト名 + 鍵に差し替える。publish をやめてもキーは識別子として残る         |
| `portal.hidden: "true"`                        | Caddy など入口そのもの              | リンクを出さない（カードと状態は残る）                                                          |

```yaml
services:
  dozzle:
    labels:
      portal.url: https://dozzle.home.arpa
  agent:
    labels:
      portal.url.4317: https://agent.home.arpa
      portal.url.4318: https://preview.agent.home.arpa
      portal.url.4319: https://service.agent.home.arpa
  caddy:
    labels:
      portal.hidden: "true"
```

- SSL 化の有無はラベルの有無ではなく URL の scheme で表す（`https` のときだけ鍵アイコン）
- ラベルがないポートは `http://<PORTAL_HOST>:<ポート>` のまま
- ラベルは `docker ps --format json` の `Labels`（カンマ区切り）から読む
- `portal.url.<ポート>` のキーは 1–65535。値が空のものは無視する
- 上書きはリンクの表示だけ。portal が TLS を終端したり、疎通確認をしたりはしない

portal 自身の HTTPS 入口と、リンクの宛先に使うホストは、ナビバー右上の設定シートで確認できる（外観の切り替えも同じ場所）。

## 技術スタック

- **バックエンド**: Bun.serve()（Express不使用）
- **フロントエンド**: React 19 + TypeScript
- **スタイリング**: Tailwind CSS 4
- **コンテナ連携**: Bun.$ テンプレートリテラル（docker psコマンド実行）

## クイックスタート

### 開発モード

```bash
bun install
bun dev
```

http://localhost:3000 でアクセス

### 環境変数

`.env` ファイルを作成するか、`.env.example` をコピーして使用してください。

| 変数名                | 説明                                                          | デフォルト    |
| --------------------- | ------------------------------------------------------------- | ------------- |
| `PORTAL_HOST`         | ポートリンクのホスト名                                        | `localhost`   |
| `USE_MOCK_DATA`       | モックデータモードを有効化                                    | `false`       |
| `NODE_ENV`            | 実行環境                                                      | `development` |
| `PORTAL_GHCR_TOKEN`   | タグ一覧用の classic PAT（`read:packages`、サーバーのみ）     | なし          |
| `PORTAL_GITHUB_TOKEN` | デプロイ起動用の fine-grained PAT（Actions = Read and write） | なし          |

```bash
# リモートホストのコンテナにアクセスする場合
PORTAL_HOST=192.0.2.10 bun run dev

# 本番モードでモックデータを使用
USE_MOCK_DATA=true NODE_ENV=production bun run start
```

### モックデータモード（Docker不要）

Dockerがインストールされていない環境や、レイアウト確認用にモックデータを使用する場合：

```bash
# モックモードで開発
bun run dev:mock

# または環境変数を直接指定
USE_MOCK_DATA=true bun dev

# モックモードで本番確認
bun run start:mock
```

モックデータには以下のテスト用コンテナが含まれています：

- 各種状態（running, exited, paused, restarting）
- 長い名前のコンテナ
- 複数ポートを持つコンテナ
- `portal.url.<ポート>` ラベル相当の URL 上書きを持つコンテナ
- 1 つ前のビルドが稼働中で、Deploy の隣に `New` が出るコンテナ
- ポートなしのコンテナ

### 本番実行

```bash
bun start
```

### Dockerビルド

```bash
docker build -t portal .
```

### 本番デプロイ

このリポジトリでは本番用 Docker Compose 定義を管理していません。CD で GHCR に push された `ghcr.io/u7chan/monorepo/portal:<tag>` を、deploy 実行側の定義から参照してください。

### イメージタグの切り替え（デプロイ UI）

カード/行の `Deploy` から、monorepo の CD が GHCR に push したイメージのタグを選んで再デプロイできます。

- 対象: `ghcr.io/u7chan/monorepo/<project>` の主コンテナだけ
- Docker Hub と第三者の GHCR（`ghcr.io/amir20/dozzle` など）はタグを切り替えない（`Deploy` を出さない）
- `latest` は可変タグなので選択肢に出さない。最新ビルドは同じ version の `sha-*` を選ぶ（`require_image_tag` の target でもそのまま使える）
- portal 自身は一覧から除外しているため、portal の更新は従来どおり Manual Deploy を使う
- タグ一覧は GitHub Packages から取得し、デプロイは self-hosted-runner の `manual-deploy.yml` を `workflow_dispatch` で起動する
- 各タグにはイメージの作成日時を `YYYY-MM-DD HH:mm:ss`（JST）で表示する。一覧は新しい順に並ぶ。選択中のタグの作成日時は選択欄の下にも出るため、欄が狭くても秒まで読める
- 稼働中のタグより後にビルドされたタグがあれば、Deploy の隣に `New` を出す。タグ一覧は 5 分キャッシュし、一覧の更新に合わせて取り直す（`/api/image-updates`）
- `New` は現在のタグがタグ一覧にある場合だけ出す。`latest`、digest 参照、保持世代を超えて一覧から消えたタグは、どのビルドが動いているかを portal が知らないため比較しない
- タグ一覧を取得できない場合も `New` を出さない。カードの一覧表示と start / stop はそのまま動き続ける
- 選択中のタグが現在のタグより古いビルドなら、`Deploy` の代わりに `Roll back` の確認シートを出す。現在のタグが一覧に無い場合（保持世代を超えて消えた等）は比較できないため確認しない
- 成功すると Actions へのリンクを表示する。コンテナの再作成は Actions 側で行う

ホスト側の `.env`（Manual Deploy が読む `ENV_FILE`）に 2 つの token を置く。

```bash
# タグ一覧用: classic PAT（read:packages）
PORTAL_GHCR_TOKEN=ghp_xxx

# デプロイ起動用: fine-grained PAT（Actions = Read and write）
PORTAL_GITHUB_TOKEN=github_pat_xxx
```

- `PORTAL_GHCR_TOKEN`: GitHub Packages / Container registry は fine-grained PAT 非対応のため classic PAT を使う。`read:packages` だけを付ける
- `PORTAL_GITHUB_TOKEN`: `u7chan/self-hosted-runner` の Actions = Read and write
- `.env` は 600 にし、リポジトリへ commit しない。どちらも有効期限を設定する
- token の変更は portal の再作成で反映する
- `PORTAL_GHCR_TOKEN` が無い・失効している場合、タグ一覧が 503 を返し、新着の印は出ない。一覧表示と start/stop は動き続ける
- `PORTAL_GITHUB_TOKEN` が無い・失効している場合、`Deploy` が 503 を返す。タグ一覧と新着の印は `PORTAL_GHCR_TOKEN` だけで動く

## ホーム画面への追加

iOS の Safari では共有メニューの「ホーム画面に追加」、Android / PC ではブラウザのインストール機能から追加する。
アプリ名は「Docker Container Portal」（ホーム画面では短縮名「Portal」）で、`src/logo.svg` を 192 / 512 / 180px にラスタライズした専用アイコンを使う（180px の `apple-touch-icon` は、iOS が角丸のマスクを掛けるため角丸を付けず全面を塗る）。起動先は `/`。
起動時の背景色とテーマカラーはダークの `canvas`（`#000000`）に揃えている。manifest は外観ごとの色を持てないため、明るい外観の端末で起動した場合は起動直後だけ暗く、読み込み後は `<meta name="theme-color">` の外観別の値に切り替わる。

Chromium の PWA インストールには HTTPS（開発時は localhost）が必要で、LAN 内の HTTP ではインストール候補に出ない場合がある。
Service Worker やオフライン対応は追加していないため、起動時は portal が動作しているホストへ接続できる必要がある。

## APIエンドポイント

| エンドポイント                       | メソッド | 説明                                                |
| ------------------------------------ | -------- | --------------------------------------------------- |
| `/api/containers`                    | GET      | コンテナ一覧取得（`?filter=all\|running\|stopped`） |
| `/api/hello`                         | GET/PUT  | ヘルスチェック用                                    |
| `/api/hello/:name`                   | GET      | パスパラメータ例                                    |
| `/api/containers/:id/deploy-options` | GET      | デプロイ可能なイメージタグ一覧を返す                |
| `/api/deployments`                   | POST     | 選択したタグで `manual-deploy.yml` を起動する       |
| `/api/image-updates`                 | GET      | 稼働中より新しいビルドがあるコンテナを返す          |

## プロジェクト構造

```
.
├── src/
│   ├── index.ts              # Bun.serve() エントリポイント（ルート表と起動）
│   ├── api/
│   │   ├── routes.ts         # /api 以下のルート表
│   │   ├── containers.ts     # コンテナ一覧と start / stop
│   │   ├── deployments.ts    # タグ一覧とデプロイ起動
│   │   ├── imageUpdates.ts   # 新着判定とタグのキャッシュ
│   │   ├── config.ts         # 接続先とモックモード
│   │   ├── health.ts         # ヘルスチェック
│   │   └── responses.ts      # API 共通のエラーレスポンス
│   ├── index.html            # HTMLテンプレート
│   ├── frontend.tsx          # Reactエントリ
│   ├── App.tsx               # ヘッダーとページ骨格
│   ├── APITester.tsx         # APIテスト用コンポーネント
│   ├── index.css             # デザイントークン (@theme)・ベーススタイル・シート / リスト行のスタイル
│   ├── logo.svg              # ロゴ / favicon
│   ├── manifest.webmanifest  # PWA のアプリ名・起動設定・アイコン
│   ├── static.ts             # manifest とアイコンの固定ルート
│   ├── assets/               # PWA / iOS ホーム画面用アイコン
│   ├── types/
│   │   └── container.ts      # 型定義
│   ├── services/
│   │   ├── docker.ts         # Docker CLI 実行と start / stop の検証
│   │   ├── dockerParser.ts   # 生 JSON / ポート / portal 自身の判定
│   │   ├── dockerLabels.ts   # portal.url / portal.hidden / compose project ラベル
│   │   └── mockData.ts       # モックデータ（Docker不要モード用）
│   ├── hooks/
│   │   ├── useConfig.ts      # ホスト名・モックモードの取得
│   │   ├── useCopy.ts        # コピー完了表示
│   │   ├── useImageUpdates.ts # 新着イメージの取得
│   │   ├── useScrollPast.ts  # 大きいタイトルがバーの下へ隠れたか
│   │   └── useTheme.ts       # 外観の設定 (<html data-theme> と theme-color)
│   ├── lib/
│   │   ├── apiClient.ts      # API 呼び出しと JSON 応答 / エラーの共通処理
│   │   ├── containerState.ts # 状態→色/操作の判定
│   │   ├── image.ts          # イメージ参照の解析・表示用の分割
│   │   ├── ports.ts          # ポートリンクの URL と表示ラベル
│   │   ├── theme.ts          # 外観設定の解釈と theme-color
│   │   └── copyToClipboard.ts
│   └── components/
│       ├── AppHeader.tsx     # ナビバー (ガラス) とコンパクトタイトル
│       ├── ContainerCard.tsx # コンテナカード / リスト行
│       ├── container/
│       │   ├── ContainerLinks.tsx        # ポート / URL のタイル
│       │   ├── ContainerHeading.tsx      # 名前と状態
│       │   ├── ImageField.tsx            # イメージ名とコピー
│       │   ├── ImageUpdateBadge.tsx      # 新しいビルドがあることを示す New
│       │   └── ContainerActionButton.tsx # 起動 / 停止ボタン
│       ├── ContainerList.tsx # 一覧・絞り込み・表示切替
│       ├── DeployControl.tsx # イメージタグの選択とデプロイ
│       ├── Sheet.tsx         # <dialog> によるシート (下から / 中央)
│       ├── ConfirmSheet.tsx  # 停止・ロールバックの確認
│       ├── SettingsSheet.tsx # 外観と接続先
│       ├── SegmentedControl.tsx # つまみが動くセグメント
│       ├── Collapsible.tsx   # 高さが滑らかに変わる開閉領域
│       ├── CopyButton.tsx
│       ├── glass.ts          # ガラス面のクラス
│       └── icons.tsx         # 共通アイコン (24px グリッド)
├── Dockerfile                # Dockerイメージ定義
└── package.json
```

## リント・フォーマット

```bash
bun lint              # 型チェック + lint
bun lint:fix          # 自動修正
bun format            # コード整形
bun format:check      # 整形チェックのみ
```

## テスト

```bash
bun test              # テスト実行
bun test --watch      # ウォッチモード
```

## 要件

- Bun 1.3.8+
- Docker（ホストマシンまたはDocker Socketマウント）※ モックモード使用時は不要
