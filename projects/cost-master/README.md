# cost-master

コンテンツ生成モデルの価格と「一覧に出す / 出さない」の判断を 1 つの HTTP 応答で返すサービス。
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

認証は無い。書き込みは判断の更新とマスタの置き換えだけで、どちらも same-origin のみ通す。応答は `Cache-Control: no-store`。

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
- `billable` は `output_image`（画像）/ `input_text` / `output_audio`（音声）。画像は出力側だけを返し、音声は入力側（文字・バイト・トークン）の行も返す
- `unit` は `image` / `megapixel` / `token` / `character` / `byte` / `minute` / `request`
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

`PUT /api/judgments` — 1 モデルの判断だけを変える（画面のスイッチ）。`Content-Type: application/json`、16 KiB まで。

```json
{ "modelId": "krea/krea-2-large", "enabled": false }
```

- 成功すると `{ "applied": true }`。現在の有効値（行が無ければ `true`）と同じならファイルを書かずに 200 を返す
- 既存行は `enabled` だけを書き換え、`note` と行の位置は保つ。行が無ければ末尾に足す。`true` に戻しても行は消さない
- 現在のファイルに落とされる行（重複・食い違い・型違い）があるときは、要求値によらず
  `400 { error: "invalid", reason: "rows" }`。ダウンロードして直し、アップロードし直す
- どちらかのファイルが壊れているときは `503 { "error": "master_unavailable" }`（`/api/models` と同じ扱い）
- `Origin` が別ホストの要求は 403。`Origin` の無い要求（curl など）は通す

価格もモデル一覧も含めない。**どちらかのファイルが読めないとき**は `ok: false` と null を返し、`/api/models` は
`503 { "error": "master_unavailable" }` になる。空の一覧を返さないのは、u7agent に「価格が消えた」と誤解させず、
前回の値を持たせるため。`enabled.json` の失敗も 503 に倒すのは、判断が 1 件も適用されないまま
「全部表示」を配信すると、隠したつもりのモデルが黙って戻るため（行単位の破損は既定へ倒す）。

## マスタのメンテ

マスタは `MASTER_DIR` に置く。コンテナでは volume を mount するので、**再デプロイせずに更新できる**。
起動時に volume にマスタが 1 つも無ければ、image に同梱した初期値をコピーする。片方だけあるときはコピー
しない（消した判断を image の初期値で黙って戻さない）。以後 image 側は読まない。

由来の違う 2 ファイルに分ける。片方の更新がもう片方を上書きしないようにするため。

| ファイル | 由来 | 触り方 |
| --- | --- | --- |
| `prices.json` | OpenRouter の endpoints API から機械生成 | `bun run generate` の出力をアップロード |
| `enabled.json` | 人の判断とメモ | 画面のスイッチ（一括はダウンロードして編集し、アップロード） |

`enabled.json` に行が無いモデルは `enabled: true`（一覧に出す）として扱う。スイッチで `true` に
戻しても行は残るので、行が無いことと `enabled: true` はどちらも「一覧に出す」を意味する。`prices.json` に
無い `modelId` の行は無視される（消さない。モデルが次の取り込みで戻ることがある）。

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

判断（1 モデルずつ）:

1. 画面（`/`）の一覧でスイッチを切り替える
2. 反映は即時。u7agent の一覧は [カタログ更新] を押すまで変わらない

一覧は名前順と単価の安い順を切り替えられる。単価の単位（`image` / `megapixel` / `token` / `request`）が違う
モデルは数値で比べられないため、安い順は同じ単位の中で並べ、単位は `image` → `megapixel` → `token` → `request`
の順にまとめる。

判断（一括・復旧）と価格:

1. 「マスタの更新」で種類を選び、[現在の … をダウンロード] を押す
2. 手元で編集する（価格は次の「価格の取り込み」で作る）
3. 同じ欄でファイルを選び [アップロード] を押す
4. 反映は即時（リクエストごとに mtime を見て読み直す）。直前の内容は `<kind>.json.bak` に 1 世代だけ残る

失敗したときは反映されない（ファイルは変わらない）。理由は画面に固定文言で出る。

スイッチの操作も `.bak` を更新する。1 世代しか残らないので、戻す用のファイルは先に
ダウンロードしておく。

### 価格の取り込み

```bash
bun run generate -- --dry-run   # 件数と差分だけ出す
bun run generate                # src/server/data/prices.json を書き換える（そのファイルをアップロードする）
```

- 上流の一覧 API と、モデルごとの endpoints API を叩く。どちらも無料で、キーは使わない
- 音声（TTS）は別系統で、一覧（`/api/v1/models?output_modalities=speech`）→ モデルごとの `/endpoints`（金額）と `llms.txt`（`## Pricing` の単位語だけ）を読む。金額は endpoints の数値が正で、`minute` だけ llms の金額で検算する。1 モデル 2 リクエストを並列 6 で引く
- 音声の単位語が未知・混在ならそのモデルは失敗し、前回の行を残す。`llms.txt` が「公開 endpoint なし」と宣言していれば「価格なし」を確定し、前回の行を落とす
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
- 書き込みは判断の更新（`PUT /api/judgments`）とマスタの置き換え（`PUT /api/master/:kind`）。DB を持たず、
  どちらも same-origin のみ通す。認証が無いぶん、到達できる範囲（LAN / VPN）が唯一の統制になる
- 扱うのは公開情報の価格と「一覧に出すか」だけで、秘密も個人情報も持たない
