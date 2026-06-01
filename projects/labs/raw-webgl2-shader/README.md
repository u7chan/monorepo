# Raw WebGL2 Shader Lab

依存なしの WebGL2 最小ひな型です。頂点シェーダーとフラグメントシェーダーは `src/main.js` 内の文字列として定義しています。

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

- `vertexShaderSource`: 頂点位置、変形、varying の実験
- `fragmentShaderSource`: 色、時間変化、ピクセル単位の表現
- `vertices`: 頂点座標と頂点カラー
