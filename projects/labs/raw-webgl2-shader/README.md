# Raw WebGL2 Shader Lab

依存なしの WebGL2 最小ひな型です。頂点シェーダーとフラグメントシェーダーは `src/shaders.js` 内の文字列として定義しています。

## Run

そのまま `index.html` をブラウザで開けます。

WSL2 から Windows ブラウザで見る場合は、以下でも起動できます。

```bash
python3 -m http.server 5173
```

その後、Windows 側の Chrome / Edge で開きます。

```text
http://localhost:5173
```

## Edit Points

- `src/shaders.js`: 頂点シェーダーとフラグメントシェーダー
- `vertices`: 頂点座標と頂点カラー
