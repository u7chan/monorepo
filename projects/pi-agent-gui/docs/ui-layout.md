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

メイン領域は チャット / 設定ページ のどちらかを出し、サイドバーのモード（nav / settings）と一致する。対応は `client/src/lib/settingsNav.ts` の `mainViewFor` が持ち、mode と settingsSection の state は `App` が持つ。設定ページは `<dialog>` を被せずメイン領域に出す（サイドバーと同時に見える）。設定ページを開いている間もチャットは mount したまま `display` だけ切るので、SSE 購読（実行中のラン）・入力中の下書き・スクロール位置は失われない（戻ると続きから見られる）。

- desktop: `Topbar`（エラー時の接続状態と見出しだけの帯）+ `ChatArea` + `Composer`（エージェント選択を常時表示し、Model / Effort は追加設定として畳む）
- 設定ページは エージェント（`AgentSettingsPage`）/ スキル（`SkillSettingsPage`）/ ファイル（`FileTreePage`）/ 外観（`AppearancePage`）の 4 つ。ヘッダは 見出し + 操作で、「アプリに戻る」は置かない（desktop の戻り導線はサイドバーの 1 つだけ。2 カラムで同じボタンが並ぶのを避ける）。**compact だけはヘッダにも「アプリに戻る」を出す**（左カラムが無く、サイドバーの導線はドロワーを開かないと押せないため）。`Escape` でもチャットへ戻る（`<dialog>` の標準挙動を失った分を `App` の keydown で明示的に受ける。nav ドロワーが開いているときはドロワーを閉じる方を優先する）。フォーカス拘束は無いので、desktop でも `Tab` / `Shift+Tab` の巡回でサイドバーの「アプリに戻る」に到達できる
- `FileTreePage`（作業ディレクトリのファイルツリー）は設定ナビの「ファイル」から開く。渡すパスは選択中セッションの実効 cwd で、未作成チャットは選択中プロジェクトの cwd、未所属は `""`（ワークスペース root）。**この cwd がツリーの root になり**、`GET /api/files` へは root 自身を `path=<cwd>`、配下を `path=<cwd>/<name>` で問い合わせる（未所属は `path=.`）。ヘッダのパス表示も同じ root 相対（root は `/`）に揃える。絶対パスは API の `path` と単位が違うことと、ワークスペース root 自身を指す `health.cwd` が混ざるのを避けるため。設定ページの中でもヘッダもツリーも画面幅いっぱいに使う（ツリーの行は深さに比例したインデントだけを持ち、幅は viewport に追従する）
- portrait / landscape: メイン領域 = チャット or 設定ページ、ドロワー = ナビ という desktop と同じ構造にする
  - `CompactBar` はチャットのときに「どのエージェントのどの会話か」と nav の導線だけを常時表示する（landscape は 1 行に畳む）
  - 設定ページは `CompactBar` の代わりにメイン領域を占めるため、**設定ページのヘッダにも nav の導線（ハンバーガー）**を出す。これが無いと エージェント / スキル / ファイル / 外観 の間を移動できない
  - サイドバー（プロジェクト階層・未所属の `Chats`・設定ナビ）は `NavSheet`（モーダル dialog のドロワー）へ退避する。`NavSheet` は desktop と同じ `Sidebar` をモード付きで使い、**モードはドロワーを閉じても保たれる**（設定モードで閉じて開き直すと設定ナビが出る）。プロジェクト・セッションの項目を選ぶとドロワーは閉じ（選択後に主画面で続ける操作はプロジェクト行の「＋」）、設定の項目を選ぶと閉じてからそのページをメイン領域に出す。折りたたみ chevron は選択ではないので閉じない
  - ドロワーは高さが足りない viewport でも全項目へ到達できるよう、drawer 全体を 1 つのスクロール領域にする（一覧だけを `flex-1` にすると 0px に潰れる）
  - `Composer` は Model / Effort を追加設定として畳み、エージェント選択の右のボタンで展開する（desktop は同じ行の右へ、compact は入力欄の上の別の行へ開く）。エージェント選択は desktop も compact と同じく入力欄の上に常時置く（選択は `Sidebar` から移した）。footnote は常時表示しない（送信できない理由や停止だけを残す）
  - `ChatArea` は余白と avatar を詰め、assistant の本文 max-width を外してコード / tool output の幅を優先する
  - 設定ページはヘッダと一覧の高さだけ詰め、ヘッダの折り返しと全幅の本文で狭い viewport に追従させる（エージェント / スキルのフォームは従来のサイズのまま。`FileTreePage` の行のインデントは深さに比例するため、横スクロールは `overflow-x-hidden` で抑える）
- compact の入力欄と選択欄は iOS Safari の focus 時ズームを避けるため 16px 以上にする（`text-[16px]`。このテーマは色トークンに `base` があるため Tailwind の `text-base` は使えない）。設定ページのフォームは従来のサイズのまま（compact の「外観」のテーマ選択だけは 16px）
- 選択欄（select）は `SelectField` で包む。ブラウザ既定のドロップダウン矢印は余白を制御できず右端に寄りすぎるため、自前の chevron（右端から 10px、右余白 32px）に置換している。幅と伸縮は wrapper 側のクラスで決める

assistant のメッセージ列は `flex-1` で列幅いっぱい（desktop は `max-w-[min(760px,86%)]`、compact は `max-w-full`）に広げる。ツール履歴の `border-y` と、その行右端のコピーボタンの x 位置が、ツール出力の伸長やメッセージの内容量で動かないようにするため。user のメッセージ列は内容幅のまま右寄せを保つ（`flex-1` を付けるとバブル背景が列幅まで広がる）。

ツール履歴は代表ステータスを持たない（1 件の失敗で全体がエラーに見え、成功したコールの情報が消えるため）。畳んだ状態でも実行中だけは分かるようにサマリーへ `実行中` を出し、それ以外の位相は各コールの行が持つ。コールの行は入れ子の `<details>` で、開くまで引数と出力は出さない（件数が多い履歴でも一覧できる）。各コールは丸枠の面を持ち、失敗したコールは `border-danger/50` の枠と右端の `エラー` ラベルで示す。

ツール履歴の行とサマリーの右端にある位相ラベル（実行中 / エラー）は `w-[3.25em]`（`text-[9px]` で 29.25px）の固定スロットに右寄せ + `whitespace-nowrap` で置く。位相で文字幅が変わると（実測 実行中 27 / エラー 27.42px）、右隣のコピーボタンと左のサマリーの truncate 境界が動くため。完了は空スロットにして、位相が違っても右端のコピーボタンの x を揃える。幅を rem 基準にするとブラウザーの既定フォントサイズが 14px のときスロットが 24.5px まで縮んで最長ラベルが 2 行に折り返し、行高まで位相で変わる。そこでラベルの文字サイズに連動する em を使う。

メッセージ本文の下の時刻ラベルとコピーボタンは本文と同じ列の中の 1 行に並べる（時刻は `at` が無ければ出さない）。assistant 列の幅は本文とツール履歴で決まり、時刻ラベルの有無や長さでは動かない。内容幅で決まる user 列では、本文よりこの行が広い短文（例: 2 文字）で時刻ラベルの分だけ列幅が広がる。

## サイドバー

サイドバーは nav / settings の 2 モードを持ち、mode は `App` が持つ（`NavSheet` は同じ `Sidebar` を開くだけなので、desktop と compact のどちらでも切替が保たれる）。実装は `client/src/components/Sidebar.tsx`。

### nav モード

上から ブランド / 「新しい会話」/ `Projects`（`New Project` + プロジェクト行）/ `Chats` / フットノート / `設定`（下部固定）。

- プロジェクト行は フォルダアイコン + 名前 + cwd 相対パスの副次表示 + 折りたたみ chevron + ホバーの「＋」「削除」。行のクリックでそのプロジェクトを選択し、配下セッションは `SessionRow` をインデント表示する
- 選択中プロジェクトは「新しい会話」の**作成先**で、開いているセッションの所属とは一致しないことがある。そのためプロジェクト行のハイライトは弱く（`accent-wash/60` と薄い枠）、セッション行（`accent-wash` と濃い枠）と区別する。**`Chats` 見出しも同じ選択**を持ち、押すと作成先を未所属へ戻す（未所属を選んでいるときは見出しが弱いハイライトになる）。プロジェクト行は選ぶだけでは解除できないため、未所属へ戻す導線はここだけ
- 並び順はプロジェクトが作成順、配下セッションと `Chats` が `lastUsedAt` 降順。グループ化は `client/src/lib/sessionsByProject.ts` の純関数が担い、未知の `projectId`（破棄直後など）は `Chats` へ寄せて一覧から消さない
- プロジェクトの追加は dialog（`ProjectDialog`）で行う。新規作成は親ディレクトリ + 名前、既存登録は対象ディレクトリを選び、どちらも `GET /api/files` を辿って選ぶ（root は登録できない）。削除の confirm は配下セッション数を示し、ディレクトリが残ることも明示する

### settings モード

「アプリに戻る」+ エージェント / スキル / ファイル / 外観 の 4 項目。項目はメイン領域のページを切り替え、開いている項目は `accent-wash` のハイライトになる（メイン領域の切替と mode の対応は [モードごとの構成](#モードごとの構成)）。テーマ切替の入口は「外観」に一本化し、`Topbar` とドロワーのカードには置かない。

一覧は `Projects` と `Chats` をまとめて 1 つのスクロール領域にし、`設定` は下部に固定する。desktop では高さが足りないとき、compact では drawer 全体のスクロールで全項目へ到達できる。

## 検証

自動テストは `client/test/layout.test.ts` がモード判定の境界を、`client/test/sessionsByProject.test.ts` がプロジェクト別のグループ化（未所属の分離・並び順）を、`client/test/settingsNav.test.ts` がサイドバーのモードとメイン領域の対応および設定ナビの 4 項目を固定する。client test の方針は jsdom を足さずに DOM に依存しないことで、純粋なロジックに加えて `client/test/eventInStateUpdater.test.ts` のようなソース走査型の回帰テストも置く。見た目は次の viewport で確認する。

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
