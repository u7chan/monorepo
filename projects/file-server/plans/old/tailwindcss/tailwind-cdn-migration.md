# Tailwind CSS v4 CDN導入

## 概要
現在インラインCSSで定義されているスタイルを、Tailwind CSS v4 CDNに置き換える。既存のデザインとレイアウトを維持しつつ、クラスベースのスタイリングに移行する。

## CDN
```
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
```

## 現行スタイルからの移行対応

### PageShellコンポーネントのスタイル置換
現在のインラインCSSスタイルをTailwindクラスに変換：

- **基本レイアウト**: `box-border`フォントファミリ、最大幅、余白、背景色
- **コンテナ**: 白背景、パディング、角丸、シャドウ
- **ナビゲーション**: リンク色、ホバー効果
- **リスト**: 表示形式、ホバー背景、枠線
- **ファイル情報**: サイズ、時間、配置
- **フォーム**: 入力欄、ボタンスタイル
- **ビューア**: 画像・動画の最大幅、角丸
- **通知**: 固定位置、アニメーション
- **htmx**: インジケーター表示

## 実装ステップ

1. **PageShell.tsx更新**
   - 既存の`<style>`ブロックを削除
   - Tailwind CDNスクリプトを追加
   - JSX要素にTailwindクラスを適用

2. **FileList.tsx更新**
   - インラインスタイルがある場合はTailwindクラスに置換
   - htmx属性を維持

3. **FileViewer.tsx更新**
   - インラインスタイルがある場合はTailwindクラスに置換
   - レスポンシブ対応を確認

4. **テスト確認**
   - 既存テストが通ることを確認
   - レンダリング結果が同等であることを検証

## 変換マッピング

### 基本スタイル
- `* { box-sizing: border-box; }` → `box-border`クラス適用
- `font-family` → `font-sans`クラス
- `max-width: 1200px` → `max-w-7xl`
- `margin: 0 auto` → `mx-auto`
- `padding: 20px` → `p-5`

### カラーパレット
- 背景 `#f5f5f5` → `bg-gray-50`
- 白背景 → `bg-white`
- リンク色 `#0066cc` → `text-blue-600`
- ホバーリンク `#0052a3` → `hover:text-blue-700`
- 削除ボタン `#cc3333` → `bg-red-600`
- ホバー削除 `#a32929` → `hover:bg-red-700`

### コンポーネントスタイル
- コンテナ: `bg-white p-5 rounded-lg shadow-sm`
- ボタン: `px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer`
- 入力欄: `px-2 py-2 border border-gray-300 rounded`
- エラー通知: `bg-red-50 text-red-700 p-4 rounded border-l-4 border-red-700`

## 注意点
- 既存のhtmx機能に影響を与えないこと
- レスポンシブデザインを維持すること
- カスタムアニメーション（`slideIn`）はTailwindのアニメーションクラスで再現
- z-indexの扱いに注意（`z-50`など）
- 既存のクラス名との衝突を避ける

## 期待される成果
- メンテナンス性の向上（クラスベーススタイリング）
- 一貫したデザインシステム
- 将来的なカスタマイズの容易さ
- バンドルサイズの最適化（CDN利用）