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

価格もモデル一覧も含めない。マスタを読めていないときは `ok: false` と null を返し、`/api/models` は
`503 { "error": "master_unavailable" }` になる。空の一覧を返さないのは、u7agent に「価格が消えた」と
誤解させず、前回の値を持たせるため。

## マスタのメンテ

マスタは由来の違う 2 ファイルに分ける。片方の更新がもう片方を上書きしないようにするため。

| ファイル | 由来 | 触り方 |
| --- | --- | --- |
| `src/server/data/prices.json` | OpenRouter の endpoints API から機械生成 | 手で編集しない |
| `src/server/data/enabled.json` | 人の判断とメモ | 手で編集する |

`enabled.json` に行が無いモデルは `enabled: true`（一覧に出す）として扱う。隠す判断だけを明示する。

```json
{
  "models": [
    { "modelId": "krea/krea-2-large", "enabled": false, "note": "1 枚 $0.06。上位解像度はさらに高い" }
  ]
}
```

同じ `modelId` を `enabled` の違う値で 2 回書いた行は、両方とも無視する（隠す判断を誤って適用しない）。

### 価格の取り込み

```bash
bun run generate -- --dry-run   # 件数と差分だけ出す
bun run generate                # prices.json を書き換える
```

- 上流の一覧 API と、モデルごとの endpoints API を叩く。どちらも無料で、キーは使わない
- 同じ `(modelId, billable, unit, variant)` が複数 endpoint にあるときは**最大単価**を採る（上流の並び順に依存させない）
- 取得に失敗したモデルは前回の行を残す。`endpoints` が空のモデルは「価格なし」を確定し、前回の行を残さない
- `prices.json` の `version` は価格行が変わったときだけ進む。`fetchedAt` は取り込みのたびに更新する
- 上流の応答本文はログにもファイルにも出さない（件数・モデル id・差分だけを出す）

取り込んだら `prices.json` をコミットしてデプロイする。マスタはデプロイ時に 1 回だけ読み、リクエストごとには
再読込しない。

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
- 書き込み API・DB・管理画面を持たない。判断の変更は `enabled.json` の編集とデプロイで行う
- 価格は公開情報だけで、秘密も個人情報も持たない
