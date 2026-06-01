# AI Driven Dev Sample

AIに要件を渡し、テスト観点を固め、テストを先に書いてから実装する流れを短時間で試すためのFastAPIサンプルです。
題材はプロセス内メモリだけを使うメモ検索APIです。外部AI API、APIキー、DB、ファイル保存は使いません。

## API

```text
GET  /health
POST /memos
GET  /memos
GET  /memos/search?q=...
```

`POST /memos` はタイトルと本文からメモを作成し、ID付きで返します。

```json
{
  "title": "AI driven development note",
  "body": "Write requirements first, then tests."
}
```

`GET /memos/search?q=test` はタイトルまたは本文に対する部分一致で検索します。検索は大文字小文字を区別しません。

## AIに渡す要件例

```text
FastAPIでメモ検索APIを作ります。

要件:
- GET /health は {"status": "ok"} を返す
- POST /memos は title と body を受け取り、id 付きのメモを201で返す
- GET /memos は作成済みメモの一覧を返す
- GET /memos/search?q=... は title と body の部分一致で検索する
- q は必須で、空文字は422にする
- データはプロセス内メモリに保存し、DBやファイル保存は使わない

先にpytestとTestClientでテスト観点を整理し、テストを書いてから実装してください。
```

## 先に書くテスト観点

| 観点 | 確認内容 |
| --- | --- |
| Health | `/health` が200と期待レスポンスを返す |
| 作成 | `POST /memos` でID付きメモを作成できる |
| 一覧 | `GET /memos` で作成済みメモを取得できる |
| 検索 | タイトルと本文の部分一致で検索できる |
| 入力検証 | 空の検索語が422になる |
| テスト分離 | テストごとにメモリストアが初期化される |

## 実行方法

依存関係を同期します。

```bash
uv sync
```

テストを実行します。

```bash
uv run pytest
```

開発サーバーを起動します。

```bash
uv run fastapi dev
```

## 教材としての進め方

1. 上の要件例をAIに渡し、テスト観点を先に出させます。
2. テスト観点をレビューし、足りない入力検証やテスト分離の観点を足します。
3. `tests/test_main.py` を先に作り、失敗することを確認します。
4. `src/main.py` を実装し、`uv run pytest` が通ることを確認します。
5. 実装後にAIへ改善観点を聞き、型、バリデーション、責務分離を見直します。

## 追加課題

- メモ削除APIを追加する
- 検索結果をID昇順または作成順で返す仕様を明文化する
- タイトルと本文の最大文字数エラーをテストする
- メモリストアを小さなクラスに分ける
- OpenAPIドキュメントを見ながらAPI契約をレビューする
