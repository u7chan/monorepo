# ADR 0004: クライアントでは DOM 操作を除いて useEffect を使わない

- Status: accepted
- Date: 2026-10-15

## 背景

React 系の UI では、外部システムと同期しない処理（データ取得、props からの導出、イベント処理）まで
`useEffect` に置かれ、依存配列や Strict Mode の再実行で壊れやすい。参照する方針は
[react-effect-discipline](https://github.com/u7chan/skill-stash/blob/main/react-effect-discipline/SKILL.md)。

## 決定

- `useEffect` は DOM の操作・購読など「React の外にある何かとの同期」に限って使う。
- データ取得は render の前に置く。ひな型では `main.tsx` の `await loadHealth()` がこれにあたる。
- 以降の取得はイベントハンドラ、または専用の取得層を優先し、component の Effect へ書かない。

## 理由

- 「何と同期するのか」を説明できない処理を Effect に置くと、再実行・stale closure・cleanup 漏れの温床になる。
- 取得を render の外へ出せば、失敗も値として扱える（`HealthState` のような union で component へ渡す）。

## 影響

- 非同期の取得は component の外へ置く。
- Effect が必要な場合は、同期対象・setup・cleanup・依存値を説明できることを条件にする。
