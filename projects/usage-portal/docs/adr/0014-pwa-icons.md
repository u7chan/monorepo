# 0014: PWA と iOS ホーム画面用のアイコン

## 状態

採用

## 背景

favicon とヘッダーのロゴだけでは、ホーム画面への追加時に使うアイコンとアプリ名を指定できない。
利用者が提示した元画像から、ホーム画面向けのサイズを用意する。

## 決定

- Web App Manifest にアプリ名「Usage Portal」、`id` / `start_url` / `scope` を `/`、`display` を `standalone` として指定する。
- 元画像の縦横比とデザインを保ち、192px と 512px の PNG を manifest の `purpose: any` アイコンにする。
- iOS 用に 180px の PNG を `apple-touch-icon` で指定する。OS による切り抜きを前提にした maskable アイコンとは宣言しない。
- manifest とアイコンは PIN 認証の外で配信する。アプリのメタデータだけを含み、利用枠や資格情報は含めない。
- 固定ルートの manifest は `no-cache`、画像は既存の favicon と同じく 1 日の公開キャッシュとする。HTML バンドルで生成されるハッシュ付きファイルの配信は Bun に任せる。
- manifest の起動画面色はライトテーマの背景色に合わせる。HTML の `theme-color` は既存 CSS と同じライト / ダークの色を指定する。
- Service Worker、オフライン対応、API キャッシュ、TLS 終端は追加しない。

## 影響

- Bun の HTML バンドル後も manifest と iOS 用アイコンを参照でき、manifest 内の画像 URL は固定の静的ルートから取得できる。
- `src` 配下にファイルを置くため、既存の Docker の test / final ステージに追加のコピー設定は要らない。
- Chromium の PWA インストールは HTTPS または localhost が前提となる。既存の LAN 内 HTTP 運用でインストール UI が出ることは保証しない。
- アプリを起動する際はオンライン接続と従来の PIN 認証が必要で、既存の認証・公開範囲は変えない。
