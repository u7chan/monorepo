# cost-master

コンテンツ生成モデルの価格と「一覧に出す / 出さない」の判断を 1 つの HTTP 応答で返す read-only サービス。
自宅 LAN または VPN の内側で動かし、u7agent の 設定 → コンテンツ生成 から手動の [カタログ更新] のときだけ読む。

会計は目的にしない。実額・残高・予算は扱わず、モデルを選ぶときの指標だけを返す。

## 起動

```bash
bun install
bun run dev   # bun --hot src/server.ts
bun run start # bun src/server.ts
```

環境変数は [.env.example](.env.example) の 2 つだけ。

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 待ち受けアドレス。LAN / VPN の内側からのみ到達させる |
| `PORT` | `3100` | 待ち受けポート |
| `MASTER_DIR` | `./data` | マスタの置き場。コンテナでは volume を mount した `/app/data` |

## API

認証は無い。書き込み API も無い。応答は `Cache-Control: no-store`。

`GET /api/models`

```json
{
  "version": 3,
  "fetchedAt": 1794600000000,
  "models": [
    {
      "provider": "openrouter",
      "modelId": "black-forest-labs/flux-3-image",
      "billable": "output_image",
      "unit": "image",
      "variant": "768",
      "costUsd": 0.041,
      "currency": "USD",
      "enabled": true,
      "note": "品質重視の汎用ラスター"
    }
  ]
}
```

- `variant` は宣言が無ければ `""`。解像度ティアとは限らず、`style_references` のような加算オプションも入る
- `billable` は出力側（`output_*`）だけ。入力側の単価は選択の指標ではないため返さない
- 価格が宣言されていないモデルは行を作らない（u7agent 側は `--` を表示する）
- `enabled: false` のモデルも行を返す（「マスタにあるが無効」と「マスタに無い」を区別できるようにする）
- `currency` は `USD` 固定。上流は通貨を宣言しないため、master が付与する

`GET /api/health`

```json
{ "ok": true, "service": "cost-master", "masterFetchedAt": 1794600000000, "version": 3 }
```

`GET /api/master/{prices,enabled}` — 現在のファイルをそのままダウンロード（編集の起点）。

`PUT /api/master/{prices,enabled}` — raw JSON をそのまま置き換える。`Content-Type: application/json`、1 MiB まで。

- 検証は起動時の読み込みより厳しく、**1 行でも不正なら全体を拒否**する（`400 { error: "invalid", reason }`）
- 置き換えるとマスタを読めなくなる場合は `reason: "master"` で拒否する（「反映したのに 503」を作らない）
- `Origin` が別ホストの要求は 403。`Origin` の無い要求（curl など）は通す
- 成功すると `{ applied: true, ok: true, service, masterFetchedAt, version }`

価格もモデル一覧も含めない。**どちらかのファイルが読めないとき**は `ok: false` と null を返し、`/api/models` は
`503 { "error": "master_unavailable" }` になる。空の一覧を返さないのは、u7agent に「価格が消えた」と誤解させず、
前回の値を持たせるため。`enabled.json` の失敗も 503 に倒すのは、判断が 1 件も適用されないまま
「全部表示」を配信すると、隠したつもりのモデルが黙って戻るため（行単位の破損は既定へ倒す）。

## マスタのメンテ

マスタは `MASTER_DIR` に置く。コンテナでは volume を mount するので、**再デプロイせずに更新できる**。
起動時に volume が空なら、image に同梱した初期値をコピーする（以後 image 側は読まない）。

由来の違う 2 ファイルに分ける。片方の更新がもう片方を上書きしないようにするため。

| ファイル | 由来 | 触り方 |
| --- | --- | --- |
| `prices.json` | OpenRouter の endpoints API から機械生成 | `bun run generate` の出力をアップロード |
| `enabled.json` | 人の判断とメモ | 画面からダウンロードして編集し、アップロード |

`enabled.json` に行が無いモデルは `enabled: true`（一覧に出す）として扱う。隠す判断だけを明示する。

```json
{
  "models": [
    { "modelId": "krea/krea-2-large", "enabled": false, "note": "1 枚 $0.06。上位解像度はさらに高い" }
  ]
}
```

同じ `modelId` を `enabled` の違う値で 2 回書いた行があると、アップロードは拒否される（起動時の読み込みでは
両方落として既定へ倒すが、アップロードは人の明示操作なので黙って捨てない）。

### 更新の手順

1. 画面（`/`）の「マスタの更新」で種類を選び、[現在の … をダウンロード] を押す
2. 手元で編集する（価格は次の「価格の取り込み」で作る）
3. 同じ欄でファイルを選び [アップロード] を押す
4. 反映は即時（リクエストごとに mtime を見て読み直す）。直前の内容は `<kind>.json.bak` に 1 世代だけ残る

失敗したときは反映されない（ファイルは変わらない）。理由は画面に固定文言で出る。

### 価格の取り込み

```bash
bun run generate -- --dry-run   # 件数と差分だけ出す
bun run generate                # src/server/data/prices.json を書き換える（そのファイルをアップロードする）
```

- 上流の一覧 API と、モデルごとの endpoints API を叩く。どちらも無料で、キーは使わない
- 同じ `(modelId, billable, unit, variant)` が複数 endpoint にあるときは**最大単価**を採る（上流の並び順に依存させない）
- 取得に失敗したモデルは前回の行を残す。`endpoints` が空のモデルは「価格なし」を確定し、前回の行を残さない
- `version` は価格行が変わったときだけ進む。`fetchedAt` は取り込みのたびに更新する
- 上流の応答本文はログにもファイルにも出さない（件数・モデル id・差分だけを出す）

**サーバーは上流へ出ない。** 取り込みは手元（または任意の作業環境）で実行し、できた `prices.json` を画面から
アップロードする。

### 更新の目安

- 値上げ・値下げに気付いたとき
- 新しいモデルが u7agent の一覧に出てきたとき（価格が `--` のままになる）
- 最低線として月 1 回

## Docker

```bash
docker build --target test  -t cost-master-test  ./projects/cost-master
docker build --target final -t cost-master       ./projects/cost-master
docker run --rm -p 3100:3100 cost-master
```

`test` ステージは `bun run check` を回す。`final` ステージは production 依存だけを入れて `bun src/server.ts` を実行する。

## 検証

```bash
bun run check      # lint → fmt:check → typecheck → test → docs:check
```

ライセンスはリポジトリ root から `./scripts/check-licenses --target projects/cost-master`。

## セキュリティの前提

- 利用者認証を持たない。到達できる範囲を LAN / VPN に限る
- 書き込みはマスタの置き換え（`PUT /api/master/:kind`）だけ。DB を持たず、アップロードは same-origin のみ通す。
  認証が無いぶん、到達できる範囲（LAN / VPN）が唯一の統制になる
- 扱うのは公開情報の価格と「一覧に出すか」だけで、秘密も個人情報も持たない
- 価格は公開情報だけで、秘密も個人情報も持たない
