# Raw WebGL2 Shader Lab

依存なしの WebGL2 最小ひな型です。頂点シェーダーとフラグメントシェーダーは `src/shaders.js` 内の文字列として定義しています。

## Run

ES Modules を使っているため、ローカルサーバーで起動します。

```bash
python3 -m http.server 5173
```

その後、Windows 側の Chrome / Edge で開きます。

```text
http://localhost:5173
```

## Edit Points

- `src/main.js`: game loop と状態更新
- `src/hud.js`: FPS などの画面表示
- `src/renderer.js`: WebGL の初期化と描画処理
- `src/webgl.js`: WebGL の低レベルな補助関数
- `src/math.js`: 行列・ベクトル計算
- `src/shaders.js`: 頂点シェーダーとフラグメントシェーダー
