# SVG Icon Guidelines

## File Naming

- ファイル名: `*-icon.tsx`（例: `check-icon.tsx`）
- コンポーネント名: `*Icon`（例: `CheckIcon`）
- named export でエクスポートする

## Component Contract

すべてのアイコンは共通の `IconProps` を受け取り、`SvgIcon` ベースコンポーネントを介してレンダリングする。

```tsx
import { type IconProps, SvgIcon } from './icon-base'

export function FooIcon({ size = 24, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} label={label} className={className} {...rest}>
      {/* SVG paths here */}
    </SvgIcon>
  )
}
```

### Props

| Prop      | 型                 | 初期値 | 説明                                           |
| --------- | ------------------ | ------ | ---------------------------------------------- |
| `size`    | `number \| string` | `24`   | アイコンの幅と高さ                             |
| `label`   | `string`           | —      | 設定時: `role="img"` + `aria-label` で意味あり |
| `...rest` | SVG attributes     | —      | `className`, `onClick` など任意の SVG 属性     |

## SVG ルール

### `viewBox`

- `viewBox` は実際の描画領域に合わせた適切な値を設定する。デフォルトは `0 0 24 24`

### 色

- 原則 `currentColor` を使用する
- 固定色（`#fff`, `#000` など）は使用しない
- 親要素の `color` または Tailwind の `text-*` で色を制御する

### アクセシビリティ

- `SvgIcon` が自動で処理するため、個別のアイコン側での対応は不要
  - `label` あり → `role="img"` + `aria-label`
  - `label` なし → `aria-hidden="true"`
- 意味を持つアイコン（ロゴ、ステータス表示など）はデフォルトで `label` を受け取れるようにする

### 不要要素の除去

- 固定の `id` 属性（例: `id="Vector"`, `id="Layer_1"`）は削除する
- 完全に重複した path 要素は 1 つにまとめる
- エクスポート元ツール由来の `<title>`, `<desc>`, metadata は削除する
- 使用していない `<defs>`, `<clipPath>`, `<mask>` は削除する

### `defs` 内の ID

- `defs` で ID 参照（`url(#foo)`）が必要な場合は、複数インスタンス同時描画時に ID 衝突が起きないようユニークな ID を生成する
- 方法: `useId()` またはコンポーネント名を含むプレフィックスをつける

## 外部素材の利用

- 外部 SVG をダウンロード・加工して利用する場合、ファイル末尾にコメントで出典とライセンスを記録する
  ```
  // Source: https://example.com/icons/foo.svg
  // License: MIT
  ```
- 独自に作成したアイコンにライセンス記述は不要

## バリアント (Variant)

- アイコンが状態や方向によって形状が変わる場合、`variant` prop を追加する
- `variant` は `IconProps` を extends した独自の props 型で定義する
- 例: `SidebarIcon` の `variant?: 'collapse' | 'expand'`

## カタログでの確認

- `bun run dev` 起動後、`/debug/svg-catalog` にアクセス
- ライトモード / ダークモードの両方で表示確認
- SidebarIcon など variant があるアイコンは各バリアントが別個に表示される
- `currentColor` 継承が機能しているか、色付き wrapper 内の表示で確認
