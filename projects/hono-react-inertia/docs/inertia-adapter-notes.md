# Inertia adapter notes

このプロジェクトは学習目的の最小構成として、Vite と React adapter を使わずに Inertia の動作を確認する。

## わかったこと

- `import.meta.glob()` は Vite の機能なので、`bun build` だけで組む場合は前提にしない。
- `@inertiajs/react` は React adapter であり、内部で React hooks と `react-dom` を使う。
- `@inertiajs/react` の `App` を `hono/jsx/dom/client` で描画すると、React の dispatcher が存在しないため `Invalid hook call` になる。
- React adapter を使うなら、ページコンポーネントも描画処理も React / React DOM に揃える必要がある。
- React を使わない場合は、`@inertiajs/core` を直接使って、対象 UI ライブラリ用の adapter 相当の処理を自前で持つ必要がある。

## 現在の方針

このリポジトリでは React を追加せず、`@inertiajs/core` と `hono/jsx/dom/client` で最小 adapter を実装する。

現在の client 側が持つ責務は次の通り。

- `getInitialPageFromDOM()` でサーバーから埋め込まれた初期 page を読む。
- Inertia の `router.init()` に `initialPage`, `resolveComponent`, `swapComponent` を渡す。
- `resolveComponent` で Inertia の page 名を Hono JSX のコンポーネントに解決する。
- `swapComponent` で遷移後の page を Hono JSX の `createRoot().render()` に渡す。

## 割り切り

これは公式 adapter と同等ではない。次のような機能は、必要になった時点で個別に実装または検証する。

- React adapter の `Link`
- React adapter の `Head`
- React adapter の `usePage`
- React adapter の `useForm`
- layout
- preserve state の扱い
- anchor click の interception
- SSR / hydration

プロダクション用途では、公式 adapter を使うか、対象 UI ライブラリ向けの adapter を十分に実装してから使う。
