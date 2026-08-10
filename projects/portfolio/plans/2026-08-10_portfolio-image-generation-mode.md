# /chat 画像生成モード

## Why

`/chat` の会話体験を維持したまま、通常のチャット設定に依存しない text-to-image の導線を追加する。

## What

- composer に会話中も保持される画像生成 On/Off badge と prompt 履歴 On/Off を表示する
- 専用 API で画像生成対応モデルを自動選択し、固定の `gpt-image-2` / `1024x1024` / PNG 設定で生成する
- 履歴 On の場合も、同一会話内の画像生成 user prompt だけを入力に含める
- file server への upload 成功後にだけ conversation を保存し、assistant metadata の `generatedImages` に公開パス等を保存する
- 再読込後も public URL から画像を表示し、preview・拡大・download を可能にする

## Constraints

- edit / variation / 参照画像は MVP の対象外
- 生成画像の Base64 は DB に保存しない。既存の upload image の Base64 保存は変更しない
- 画像表示の data boundary は `GeneratedImage` に切り出し、将来の upload image 共用を妨げない
- metadata は既存 JSONB を利用するため DB schema migration は不要

## API / file server

`POST /api/image/generations` が生成と file server upload を一連で扱う。file server が未設定、login 失敗、upload 失敗の場合は生成成功を返さず、conversation も保存しない。認証情報は既存の `FILE_SERVER_URL`、`FILE_SERVER_PUBLIC_URL`、`FILE_SERVER_ADMIN_USERNAME`、`FILE_SERVER_ADMIN_PASSWORD` を利用する。
