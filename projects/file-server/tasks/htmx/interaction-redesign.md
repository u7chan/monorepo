# htmxによるインタラクション再設計

## 概要
htmx（バージョン 2.0.8）を導入し、ファイルサーバーのUIをサーバーサイドレンダリング＋部分更新で刷新する。ページ遷移なしに一覧表示、ファイル閲覧、アップロード/削除/フォルダ作成を行えるようにする。

## CDN
`https://cdn.jsdelivr.net/npm/htmx.org@2.0.8/dist/htmx.min.js`

## エンドポイント再設計

| エンドポイント | 役割 | 出力形式 | 備考 |
|---|---|---|---|
| `/` | フルHTMLシェル（初期レンダリング） | HTML | `HX-Request` ヘッダがない場合のみ |
| `/browse?path=` | 一覧部分HTML（htmx用） | HTML | `HX-Request` 時のみ、または常に部分HTMLで判断 |
| `/file?path=` | ファイル閲覧部分HTML（htmx用） | HTML | `HX-Request` 時のみ、または常に部分HTMLで判断 |
| `/api/*` | 既存JSON API（必要に応じて残す） | JSON | 非htmxクライアント向けに残す |

## UI/インタラクション刷新

### 一覧表示
- パンくずリンクに `hx-get` + `hx-target` + `hx-push-url` を付与
- ファイル名リンク（ディレクトリ）も同様
- ファイル名リンク（ファイル）は `hx-get` で閲覧部分へ

### 操作（upload / delete / mkdir）
- フォームに `hx-post` + `hx-target` + `hx-swap` を付与
- 成功時は一覧部分を再描画
- エラー時は通知領域に `hx-swap-oob` または `HX-Trigger` で反映

### ファイル閲覧
- テキストファイルは `<pre>` で部分HTMLとして返却
- バイナリ（画像/動画/PDF）は `<img>`/`<video>`/`<iframe>` として返却

## コンポーネント分割

### FileList
- **ページシェル**: `<html>` 全体を含む（htmx CDN含む）
- **リスト部分**: パンくず＋ファイルリスト＋操作フォームのみ

### FileViewer
- **部分テンプレート**: ファイル内容の表示部のみ

## フロー

1. 初期アクセス `/` → フルHTMLシェル（初期一覧を含む）
2. ディレクトリ移動 → `hx-get="/browse?path=..."` でリスト部分を差し替え
3. ファイル閲覧 → `hx-get="/file?path=..."` で閲覧部分を差し替え
4. アップロード/削除/作成 → `hx-post` で実行後、一覧部分を再描画

## 注意点
- `HX-Request` ヘッダでフル/部分の出し分けを行う
- 既存テスト（`tests/*`）はHTML出力に合わせて調整
- パスバリデーションは既存の `isInvalidPath` を継続

## 実装ステップ
1. `src/index.tsx` にフルHTMLシェルテンプレートを作成
2. `/browse` エンドポイントで一覧部分HTMLを返すよう実装
3. `/file` エンドポイントで閲覧部分HTMLを返すよう実装
4. `FileList` をシェルとリスト部分に分離
5. `FileViewer` を部分テンプレート化
6. htmx CDNをシェルに追加
7. 各リンク・フォームに `hx-*` 属性を追加
8. エラー表示領域を追加し `hx-swap-oob`/`HX-Trigger` 対応
9. 既存テストを調整
