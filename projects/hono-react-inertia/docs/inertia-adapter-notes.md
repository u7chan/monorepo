# Inertia adapter メモ

学習目的の最小構成。
Vite と React adapter は不使用。
Inertia の動作確認が目的。

## わかったこと

- `import.meta.glob()` は Vite の機能
- `bun build` だけで組む場合は前提外
- `@inertiajs/react` は React adapter
- `@inertiajs/react` は内部で React hooks と `react-dom` を使用
- `@inertiajs/react` の `App` を `hono/jsx/dom/client` で描画すると `Invalid hook call`
- 原因は React の dispatcher 不在
- React adapter 利用時はページコンポーネントも描画処理も React / React DOM
- React 不使用時は `@inertiajs/core` を直接使用
- 対象 UI ライブラリ向け adapter 相当の処理は自前実装

## 現在の方針

React は追加しない方針。
`@inertiajs/core` と `hono/jsx/dom/client` で最小 adapter を実装。

現在の client 側の責務。

- `getInitialPageFromDOM()` でサーバー埋め込みの初期 page を取得
- Inertia の `router.init()` に `initialPage`, `resolveComponent`, `swapComponent` を渡す
- `resolveComponent` で Inertia の page 名を Hono JSX コンポーネントに解決
- `swapComponent` で遷移後の page を Hono JSX の `createRoot().render()` に渡す

## SSR について

ページコンポーネントは SSR していない。
hydration もしていない。
サーバー側は Inertia page JSON を HTML に埋め込み。
`<div id="app"></div>` は空。
初回描画は client 側。
props は SSR 風に受け渡し。

## 割り切り

公式 adapter と同等ではない。
次の機能は必要になった時点で実装または検証。

- React adapter の `Link`
- React adapter の `Head`
- React adapter の `usePage`
- React adapter の `useForm`
- layout
- preserve state の扱い
- anchor click の interception
- SSR / hydration

プロダクション用途では公式 adapter を使用。
または対象 UI ライブラリ向け adapter を十分に実装してから使用。
