# レイアウトモード

チャット UI のシェルは viewport から決まる 3 モードを持つ。判定の正は `client/src/lib/layout.ts` の `resolveLayoutMode(width, height)` で、`useLayoutMode` が resize / orientationchange で追従する（CSS のメディアクエリでは分岐しない）。

## モードと境界

| モード | 条件 | シェル |
| --- | --- | --- |
| desktop | 幅 >= 720px かつ 高さ >= 560px | 252px Sidebar + main（従来どおり） |
| landscape | 高さ < 560px | compact bar + Chat + compact Composer |
| portrait | 幅 < 720px（高さは 560px 以上） | compact bar + Chat + compact Composer |

desktop に幅だけでなく高さも要求するのは、横向きスマホ（例: iPhone 14 の 844x390）が幅 720px を超えるため。幅だけで 2 カラムを選ぶと、高さ 390px の画面に Sidebar とヘッダが常駐し、ChatArea が数十 px まで潰れる。landscape は横向きスマホだけでなく、低いデスクトップウィンドウも同じ扱いにする。

## モードごとの構成

- desktop: `Topbar`（theme / model / 接続状態）+ `ChatArea` + `Composer`（Model / Effort を常時表示）
- portrait / landscape: `CompactBar` が「どのエージェントのどの会話か」と nav の導線だけを常時表示する（landscape は 1 行に畳む）
  - セッション一覧・エージェント選択・エージェント / スキル管理・作業ディレクトリ・テーマは `NavSheet`（モーダル dialog のドロワー）へ退避する。項目を選ぶとドロワーは閉じる
  - ドロワーは高さが足りない viewport でも全項目へ到達できるよう、drawer 全体を 1 つのスクロール領域にする（セッション一覧だけを `flex-1` にすると 0px に潰れる）
  - `Composer` は Model / Effort を畳み、入力欄の左のボタンで展開する。footnote は常時表示しない（送信できない理由や停止だけを残す）
  - `ChatArea` は余白と avatar を詰め、assistant の本文 max-width を外してコード / tool output の幅を優先する
  - `ManagerScreen` は full screen のまま、ヘッダと一覧の高さだけ詰める
- compact の入力欄と選択欄は iOS Safari の focus 時ズームを避けるため 16px 以上にする（`text-[16px]`。このテーマは色トークンに `base` があるため Tailwind の `text-base` は使えない）。`ManagerScreen` のフォームは従来のサイズのまま

## 検証

自動テストは `client/test/layout.test.ts` がモード判定の境界だけを固定する（client test は DOM を使わない純粋なロジックのみ、という方針）。見た目は次の viewport で確認する。

| 用途 | viewport |
| --- | --- |
| desktop | 1440x900 |
| tablet | 820x1180 |
| phone portrait | 390x844 |
| phone landscape | 844x390 |
| 低いウィンドウ | 1440x500 |

## 制約

- Android Chrome はソフトキーボード表示で `window.innerHeight` が縮むため、desktop 表示中に入力すると一時的に landscape へ切り替わることがある（キーボードを閉じると戻る）。高さの判定に `visualViewport` は使っていない
- 幅 720px 未満のタブレット（例: 600x960）は portrait になり、Sidebar はドロワーへ退避する
- iOS Safari の safe-area は `Composer` の下余白（`max(8px, env(safe-area-inset-bottom))`）で扱う。viewport meta は変更しておらず、`viewport-fit=cover` は指定していない
