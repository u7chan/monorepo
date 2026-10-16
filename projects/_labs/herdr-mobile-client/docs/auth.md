# 共有トークン認証

`/api/*` は原則として `Authorization: Bearer <token>` を要求する（`/api/health` を含む）。
例外は QR ペアリングの 2 つの API で、交換の `POST /api/pair` は認証不要、発行の `POST /api/pair/new` は loopback からのリクエストだけを受け付ける（それ以外は 404）。[pairing.md](./pairing.md) を参照する。
HTTPS も複数ユーザーも持たない PoC の割り切りで、トークンは「同一 LAN の第三者がそのまま叩ける状態」を避けるために置いている。

## トークンの決め方

- `HERDR_CLIENT_TOKEN` があればその値を使う。再起動しても変わらない。
- 未設定なら `crypto.randomBytes(32)` で生成し、起動ログに 1 回だけ表示する。再起動のたびに変わる。

```bash
# 固定する場合
PORT=18081 HERDR_CLIENT_TOKEN='<固定値>' pnpm start

# 生成させる場合（トークンが起動ログに出る）
PORT=18081 pnpm start
```

- 起動ログにトークンを出すのは PoC の割り切り。ログをファイルへ残す場合は、共有ディレクトリを避け、`umask 077` などで読める相手を限る。

  ```bash
  umask 077
  PORT=18081 pnpm start > /path/to/herdr-mobile-client.log 2>&1
  ```

- スマホへは `pnpm pair` の QR で渡せる（手入力が不要になる）。仕組みは [pairing.md](./pairing.md) を参照する。

- 判定は定数時間で行い、長さの差が比較の分岐に出ないよう固定長へ揃えてから比較する。欠落・形式不正（`Bearer` でない、トークンが空、余分な要素がある）・不一致はすべて 401 を返す。
- 401 の応答本文にトークン値は含めない。`WWW-Authenticate` も返さない（ブラウザのネイティブな認証ダイアログとクライアントの入力画面が二重になるため）。

## クライアントの持ち方

- 入力画面で受けたトークンは `sessionStorage` に置く。理由は次のとおり。
  - `localStorage` はブラウザを閉じても残る。PoC のトークンは再起動で変わりうるため、残ると「古いトークンで 401」を繰り返す原因になる。
  - Cookie は使わない。CSRF 面と、SSE などで Cookie に頼る設計を持ち込まないため（`Authorization` を付けられる取得方法と揃える）。
  - URL のクエリには載せない（履歴と Referer に残る）。
- 入力欄は `type="text"` + `autocomplete="off"` にする。`type="password"` は OS / ブラウザのパスワードマネージャを呼び、生成された別の値を入力させて 401 の原因になる。
- 401 を受けたら入力画面へ戻し、保存済みのトークンも消す。
- **401（トークン不一致）と到達不能（ネットワークエラー / サーバー不達）は文言を分ける。** 取り違えると、LAN や portproxy の設定をトークンの問題として探すことになる（[lan-access.md](./lan-access.md)）。
