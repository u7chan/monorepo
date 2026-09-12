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

- desktop: `Topbar`（theme / エラー時の接続状態）+ `ChatArea` + `Composer`（エージェント選択を常時表示し、Model / Effort は追加設定として畳む）
- `FileTreeScreen`（作業ディレクトリのファイルツリー）はサイドバーの「作業ディレクトリ」カードから開く。メイン画面のレイアウトには分離した full screen の dialog で、`ManagerScreen` と同じくヘッダもツリーも画面幅いっぱいに使う（ツリーの行は深さに比例したインデントだけを持ち、幅は viewport に追従する）
- portrait / landscape: `CompactBar` が「どのエージェントのどの会話か」と nav の導線だけを常時表示する（landscape は 1 行に畳む）
  - セッション一覧・エージェント / スキル管理・作業ディレクトリ・テーマは `NavSheet`（モーダル dialog のドロワー）へ退避する。項目を選ぶとドロワーは閉じる。「作業ディレクトリ」から開く `FileTreeScreen` もドロワーを閉じてから全幅で開く（入口は `Sidebar` の共通カード）
  - ドロワーは高さが足りない viewport でも全項目へ到達できるよう、drawer 全体を 1 つのスクロール領域にする（セッション一覧だけを `flex-1` にすると 0px に潰れる）
  - `Composer` は Model / Effort を追加設定として畳み、エージェント選択の右のボタンで展開する（desktop は同じ行の右へ、compact は入力欄の上の別の行へ開く）。エージェント選択は desktop も compact と同じく入力欄の上に常時置く（選択は `Sidebar` から移した）。footnote は常時表示しない（送信できない理由や停止だけを残す）
  - `ChatArea` は余白と avatar を詰め、assistant の本文 max-width を外してコード / tool output の幅を優先する
  - `ManagerScreen` は full screen のまま、ヘッダと一覧の高さだけ詰める。`FileTreeScreen` も同じく full screen のまま、ヘッダの折り返しと全幅のツリーで狭い viewport に追従させる（行のインデントは深さに比例するため、横スクロールは `overflow-x-hidden` で抑える）
- compact の入力欄と選択欄は iOS Safari の focus 時ズームを避けるため 16px 以上にする（`text-[16px]`。このテーマは色トークンに `base` があるため Tailwind の `text-base` は使えない）。`ManagerScreen` のフォームは従来のサイズのまま
- 選択欄（select）は `SelectField` で包む。ブラウザ既定のドロップダウン矢印は余白を制御できず右端に寄りすぎるため、自前の chevron（右端から 10px、右余白 32px）に置換している。幅と伸縮は wrapper 側のクラスで決める

assistant のメッセージ列は `flex-1` で列幅いっぱい（desktop は `max-w-[min(760px,86%)]`、compact は `max-w-full`）に広げる。ツール履歴の `border-y` と、その行右端の 完了 / エラー ラベル・コピーボタンの x 位置が、ツール出力の伸長やメッセージの内容量で動かないようにするため。user のメッセージ列は内容幅のまま右寄せを保つ（`flex-1` を付けるとバブル背景が列幅まで広がる）。

ツール履歴の行とサマリーの右端にある位相ラベル（完了 / 実行中 / エラー）は `w-[3.25em]`（`text-[9px]` で 29.25px）の固定スロットに右寄せ + `whitespace-nowrap` で置く。位相で文字幅が変わると（実測 完了 18 / 実行中 27 / エラー 27.42px）、左隣のコピーボタンとサマリーの truncate 境界が動くため。右寄せなのでラベルの文字の右端は固定幅でも動かない。幅を rem 基準にするとブラウザーの既定フォントサイズが 14px のときスロットが 24.5px まで縮んで最長ラベルが 2 行に折り返し、行高まで位相で変わる。そこでラベルの文字サイズに連動する em を使う。

メッセージ本文の下の時刻ラベルとコピーボタンは本文と同じ列の中の 1 行に並べる（時刻は `at` が無ければ出さない）。assistant 列の幅は本文とツール履歴で決まり、時刻ラベルの有無や長さでは動かない。内容幅で決まる user 列では、本文よりこの行が広い短文（例: 2 文字）で時刻ラベルの分だけ列幅が広がる。

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
