# レイアウトモード

チャット UI のシェルは viewport から決まる 3 モードを持つ。判定の正は `client/src/lib/layout.ts` の `resolveLayoutMode(width, height)` で、`useLayoutMode` が resize / orientationchange で追従する（CSS のメディアクエリでは分岐しない）。

## モードと境界

| モード | 条件 | シェル |
| --- | --- | --- |
| desktop | 幅 >= 720px かつ 高さ >= 560px | 幅 >= 1200px は 252px Sidebar + main、1200px 未満は左バーを ☰ の overlay へ退避 |
| landscape | 高さ < 560px | compact bar + Chat + compact Composer |
| portrait | 幅 < 720px（高さは 560px 以上） | compact bar + Chat + compact Composer |

desktop に幅だけでなく高さも要求するのは、横向きスマホ（例: iPhone 14 の 844x390）が幅 720px を超えるため。幅だけで 2 カラムを選ぶと、高さ 390px の画面に Sidebar とヘッダが常駐し、ChatArea が数十 px まで潰れる。landscape は横向きスマホだけでなく、低いデスクトップウィンドウも同じ扱いにする。

desktop の中でも viewport が 1200px 未満なら、左バー（252px）を常駐させず `NavSheet` の overlay へ退避し、空いた 252px をチャットと右パネルへ回す。閾値 1200 は右パネルの幅 `min(360px, 30vw)` が縮み始める幅（30vw = 360px）と同じで、「狭くなるとパネルもチャットも苦しい帯」の入口を 1 つの数字で表す。判定は `client/src/lib/layout.ts` の `resolveSidebarPlacement(width, mode)` が正で、compact は幅に関係なく常に overlay（モード判定と同じく CSS のメディアクエリでは分岐しない）。

## モードごとの構成

メイン領域は チャット / 設定ページ のどちらかを出し、URL（`/` または `/settings/<section>`）がそれを決める（[frontend.md](frontend.md#url-と画面の対応)）。設定ページは `<dialog>` を被せずメイン領域に出す（サイドバーと同時に見える）。compact の詳細（エージェント / スキルの編集）だけはページの一覧から開く全画面シートにする（[compact の詳細シート](#compact-の詳細シート)）。設定ページを開いている間もチャットは mount したまま `display` だけ切るので、SSE 購読（実行中のラン）・入力中の下書きは失われない。スクロール位置はアプリとして復元しない（非表示中は `scrollHeight` を読めないので触らず、戻ったときに追従中なら最新へ揃える）。実測（Chromium / 1440x900）では追従が外れているときの往復でも `scrollTop` は保持され（`8474 → 8474`、先頭に見えていたバブルも offset 差 0）、位置の保持はブラウザー任せで保証はしない。詳細は[チャットの自動追従と最下部ボタン](#チャットの自動追従と最下部ボタン)。

画面切替は履歴を追加しない（`replaceState`）。Back / Forward はブラウザーの既存履歴に従うので、アプリ内に戻れることもあれば、直リンクの新規タブのようにアプリの外へ出ることもある。

- desktop: `Topbar`（eyebrow + 作業先チップ + エラー時の接続状態 + 通知トグル + 作業フォルダ。左バーが overlay の帯では eyebrow の左に ☰ を足す。配信できないときの注記は compact と同じくバーの下に出る）+ `ChatArea` + `Composer`（エージェント選択を常時表示し、Model / Effort は追加設定として畳む）
- 設定ページは エージェント（`AgentSettingsPage`）/ スキル（`SkillSettingsPage`）/ ファイル（`FileTreePage`）/ アーカイブ（`ArchiveSettingsPage`）/ 外観（`AppearancePage`）/ ランタイム（`RuntimePage`）/ 通知（`NotificationSettingsPage`）の 7 つ。並びは `client/src/lib/settingsNav.ts` の `SETTINGS_SECTIONS` が正で、アーカイブはツリーの行のダウンロード導線と対になる設定なのでファイルの直後に置く。ヘッダは 見出し + 操作で、「アプリに戻る」は置かない（desktop の戻り導線はサイドバーの 1 つだけ。2 カラムで同じボタンが並ぶのを避ける）。**compact だけはヘッダにも「アプリに戻る」を出す**（左カラムが無く、サイドバーの導線はドロワーを開かないと押せないため）。**左バーが overlay の帯では見出しの左に ☰ を出す**（compact は CompactBar の代わりに、狭い desktop は常駐する左バーが無いため。出すのは `onOpenNav` があるときだけ）。`Escape` でもチャットへ戻る（`<dialog>` の標準挙動を失った分を `App` の keydown で明示的に受ける。nav ドロワーが開いているときはドロワーを閉じる方、compact の詳細シートが開いているときはシートの方を優先する）。フォーカス拘束は無いので、desktop でも `Tab` / `Shift+Tab` の巡回でサイドバーの「アプリに戻る」に到達できる
- `FileTreePage`（ワークスペースのファイルツリー）は設定ナビの「ファイル」から開く。root は選択中セッション / プロジェクトに追随させず、常にワークスペース root（`cwd=""`、ヘッダのタイトルは「ワークスペース」）に固定する（同じ画面が選択状態で別の場所を指すと、今どこを見ているか分からなくなる。セッションの作業ディレクトリはプロジェクトの登録ディレクトリや `.u7agent/sessions/<id>` をツリーから辿って開く）。**この root がツリーの root になり**、`GET /api/files` へは root 自身を `path=.`、配下を `path=<name>` で問い合わせる。ヘッダのパス表示も同じ root 相対（root は `/`）に揃える。絶対パスは API の `path` と単位が違うことと、ワークスペース root 自身を指す `health.cwd` が混ざるのを避けるため。設定ページの中でもヘッダは画面幅いっぱいに使う（ツリーの行は深さに比例したインデントだけを持ち、幅は viewport に追従する）。行の右端は 時刻 + ダウンロード + リネーム（フォルダ行のみ）+ 削除 のスロットで、リネームの鉛筆はこの画面だけに出し、チャット右パネルには出さない（[file-preview.md](file-preview.md#リネーム)、[file-preview.md](file-preview.md#ダウンロード)）。ツリーの状態（`client/src/lib/fileTree.ts`）はパスをキーにするため、`__proto__` のような名前でも壊れないよう own プロパティとして読み書きする（`Object.hasOwn` と `Object.defineProperty`）
  - 本文はツリーとプレビューを、本文のコンテナ（`@container`）幅が `@2xl`（672px）以上なら左右、未満なら上下に積む。viewport ではなくコンテナ幅で判定するのは、main の幅が「サイドバー 252px」を引いた残りで決まるため（docked のとき。左バーが overlay の帯は main が viewport 幅いっぱいになる）、1440x900 は本文 1188px で左右、720px 幅の desktop は 468px で上下）。左右のときツリーは `w-72` 固定、上下のときはタブが無ければ全幅、あれば `max-h-64` でプレビュー本文へ高さを譲る（タブが無いときに列を空けない）
  - プレビューはタブ式。タブは開いた順に並び（選択では並びを変えない）、同時に開けるのは 8 枚（`client/src/lib/fileTabs.ts` の `FILE_TAB_LIMIT`）で、超えたら最も古いタブを閉じる（本文の保持量の上限でもある）。タブのラベルは名前だけで、同名のタブがあるときだけ親ディレクトリを前置する（`client/package.json`）。全体パスは tooltip とタブ下のパス行に出す。本文はタブごとに保持して切替では取り直さない（閉じたタブの本文は捨てる）。「再読み込み」はタブを保ったまま本文を捨てて取り直す。本文は行番号付きで出し、拡張子から判定できた言語は `highlight.ts` で色を付ける（[file-preview.md](file-preview.md)）
  - HTML（`.html` / `.htm`）のタブはパス行のトグルで ソース / プレビュー を切り替える。既定はプレビューで、プレビューは `GET /api/files/html/<root 相対>` を src にした `sandbox="allow-scripts"` の iframe（背景は白）。このときはソース本文を取得しない（トグルはパス行の中だけに置き、他の拡張子には出さない）。プレビューはパス行のボタンで viewport いっぱいのモーダル dialog（`showModal()`）にでき、compact でも同じ扱いで、全画面に残すのは `全画面をやめる` の 1 行だけにする（[file-preview.md](file-preview.md#全画面)）
- desktop のチャット画面には、選択中セッションの作業ディレクトリ（`payload.cwd`。プロジェクト所属なら登録ディレクトリ、未所属なら `.u7agent/sessions/<id>`）を見る右パネル（`SessionFilesPanel`）を出せる。シェルの main 列の右に置き（3 カラム目。左バーが overlay の帯では 2 カラム目）、幅は左端のハンドルで選ぶ。ヘッダは h2「作業フォルダ」と root（root 相対の `<code>`）を出す（新規会話ではプロジェクトのフォルダを指すため、ラベルだけでは場所が分からない）。`Topbar` の「作業フォルダ」で開閉し、開閉状態は URL にも localStorage にも保存しない。既定は[作業先と作業フォルダの導線](#作業先と作業フォルダの導線)を参照
  - 幅の規則は `client/src/lib/sessionFilesPanel.ts` が正。下限は `min(360px, 30vw)`（未指定のときの幅 = 従来幅。720px 幅の desktop では 216px）、上限は `min(671px, main − 320px)`。`main` は左バーを引いた列の幅で、呼び出し側が渡す（docked は `viewport − 252`、左バーが overlay の帯は `viewport`。式は配置に依存しない）。320px は上限の基準であって保証ではなく、下限が優先される帯（docked で viewport 817px 以下）ではチャットは 320px を割る（720px では パネル 216 / チャット 252 で従来と同じ）
  - 上限を 671px で止めるのは `FileBrowser` の `@container` `@2xl`（672px）を発火させないため。発火するとツリーとプレビューが左右に並び、かえって読める幅が減る（実測: パネル 671 → code 670、672 → 671、700 → 410）
  - ハンドルは ドラッグ（pointer capture、幅は開始幅からの絶対計算）/ ←→（16px）/ Home / End / ダブルクリック（未指定へ戻す）で操作する。`role="separator"` / `aria-orientation="vertical"` / `aria-valuemin|max|now` を持ち、`aria-valuenow` は値の変化に追随する（ドラッグ中は state へ入れず DOM へ直接書く）。min == max になる幅（例: 720px）ではハンドルごと出さない
  - 選んだ幅は `localStorage` の `u7agent-session-files-width` に px の整数だけを保存する（端末ごとの表示設定なのでサーバー設定には入れない）。整数でない / 0 以下 / 2000px 超の保存値は未設定として捨て、今の bounds を外れていても捨てない（表示時に clamp するだけにして、広げ直したときに選んだ幅へ戻せるようにする）。ダブルクリックの「未指定へ戻す」はキーを削除する
  - ドラッグ中は React を再描画せず、`main` の CSS 変数 `--session-files-width` だけを書き換える（右パネルはツリーとハイライトを含み、move ごとの再描画が重い）。確定は pointerup / pointercancel / lostpointercapture / アンマウントのどの経路でも同じ処理を通し、state と保存値をそこで 1 度だけ更新する（幅が変わらないドラッグは保存しない）
  - 中身は 設定 → ファイル と同じ `FileBrowser` を root 違いで使うため、タブ / プレビュー / HTML の全画面 / タブ上限は同じ振る舞いになる（フォルダ行のリネームだけは設定 → ファイル 専用）。パネルの幅は 671px までなので container 幅が `@2xl`（672px）に届かず、ツリーとプレビューは常に縦積み（タブがあるときツリーは `max-h-64`）
  - セッションファイルの入口はチャット画面だけに出す。desktop は `Topbar` から右パネル、compact は `CompactBar` のフォルダボタンから全画面 `SessionFilesSheet` を開く。設定ページでは 設定 → ファイル と二重になるため出さない
  - トグルは作業フォルダの root が決まっているときだけ出す（`client/src/lib/sessionFiles.ts` の `sessionFilesRoot`）。root は選択中セッションの `payload.cwd`、セッション未作成では作成先プロジェクトの `cwd`（`sessionId === ""` かつ作成先が解決済みのときだけ渡す）、未所属の新規会話と設定ページは `""` にする（ワークスペース root へは落とさない）。root の可用性は layout に依存させず、表示方法だけを `App` で分ける。セッションを切り替えると `key` の張り替えでパネル / シートを作り直し、復元と取得をその root でやり直す
  - 一覧と開いている本文の取り直しは、ヘッダの「再読み込み」と reducer が `run_end` で進める `runEndSeq` の 1 回だけ（[file-preview.md](file-preview.md#画面と-root)）
- portrait / landscape: メイン領域 = チャット or 設定ページ、ドロワー = ナビ という desktop と同じ構造にする
  - `CompactBar` はチャットのときに「作業先と、どのエージェントのどの会話か」、通知トグル、作業フォルダ、nav の導線を常時表示する（landscape は 1 行に畳む）。エージェント名の行（landscape はタイトルの左）は `〈作業先〉· 〈エージェント名〉` にする。どちらの layout も省略表示にし、landscape の作業先行は `shrink-0` にせず `min-w-0` + `max-w-1/2`（行の半分）で収縮させる（プロジェクト名に長さ制限が無いため。`shrink-0` だと名前の分だけ右へ伸び、タイトルと固定幅のボタンを viewport 外へ押し出す）。作業フォルダはチャット幅を奪う右パネルではなく全画面 modal sheet（`SessionFilesSheet`）で開き、同じ `FileBrowser` を viewport 幅いっぱいで使う
  - `CompactBar` のコントロールは左から ☰（nav）/ 🔔（通知）/ 📁（作業フォルダ）で、どれも 36px（`styles/index.css` の `.icon-button`）・間隔 10px（`gap-2.5`）＝固定 138px。エージェント名とタイトルは残り幅を truncate する。実測（Chromium）ではタイトル列が 390x844 で 228px、320x640 で 158px になり、320px でも横スクロールは出ない（`documentElement.scrollWidth` = viewport 幅）。1 行に畳む landscape の 844x390 では、作業先行が 105 文字のとき `max-w-1/2` の 410px で省略表示になり、タイトルは 262px を保ち、通知（左端 750）/ 作業フォルダ（右端 832）が viewport（844）内に残る。通知が On でも配信できない（Webhook 未設定 / グローバル無効）ときは、バーの下に 1 行の注記（理由 + `設定を開く` の導線）を出し、バーは 390x844 で 52px + 注記 26px になる（色では表さない。押しても On にできないため、まだ On でないときは押した後にだけ出す）
  - 設定ページは `CompactBar` の代わりにメイン領域を占めるため、**設定ページのヘッダにも nav の導線（ハンバーガー）**を出す。これが無いと エージェント / スキル / ファイル / アーカイブ / 外観 の間を移動できない
  - サイドバー（プロジェクト階層・未所属の `Chats`・設定ナビ）は `NavSheet`（モーダル dialog のドロワー）へ退避する。`NavSheet` は desktop と同じ `Sidebar` をモード付きで使い、**モードはドロワーを閉じても保たれる**（設定モードで閉じて開き直すと設定ナビが出る）。プロジェクト・セッションの項目を選ぶとドロワーは閉じ（選択後に主画面で続ける操作はプロジェクト行の「＋」）、設定の項目を選ぶと閉じてからそのページをメイン領域に出す。折りたたみ chevron は選択ではないので閉じない
  - ドロワーは高さが足りない viewport でも全項目へ到達できるよう、drawer 全体を 1 つのスクロール領域にする（一覧だけを `flex-1` にすると 0px に潰れる）
  - `Composer` は Model / Effort を追加設定として畳み、エージェント選択の右のボタンで展開する（desktop は同じ行の右へ、compact は入力欄の上の別の行へ開く）。**compact は送信が成立した時点で畳む**（狭い画面で入力欄の上を占め、生成中はピッカーを無効化していて操作できないため。畳む合図を送信の成立である `sending` の立ち上がりに置くのは、送信経路が入力欄に限らず `ChatArea` の suggestion もあるため。送信が成立しなかったときは `sending` が立たないので畳まない）。desktop は送信しても開いたままにする。エージェント選択は desktop も compact と同じく入力欄の上に常時置く（選択は `Sidebar` から移した）。footnote は常時表示しない（送信できない理由や停止だけを残す）。添付のチップ列とクリップボタンも入力欄と同じ行に置き、チップは入力欄の上の行へ折り返す（[session-files.md](session-files.md#添付ファイルチャットからのアップロード)）
  - `ChatArea` は余白と avatar を詰め、assistant の本文 max-width を外してコード / tool output の幅を優先する
  - compact の単一列 Grid は implicit な `auto` 列にせず `minmax(0, 1fr)`（Tailwind の `grid-cols-1`）で viewport 幅に拘束する。シェル境界とメッセージ行には `min-w-0` を置き、コード / 表 / 図のような横長コンテンツだけを各コンポーネント内で横スクロールさせる
  - 設定ページはヘッダと一覧の高さだけ詰め、ヘッダの折り返しと全幅の本文で狭い viewport に追従させる（エージェント / スキルの編集は [compact の詳細シート](#compact-の詳細シート) に出し、どちらのフォームも スクロールする本文 + 固定アクション行 で組む。`FileTreePage` の行のインデントは深さに比例するため、横スクロールは `overflow-x-hidden` で抑える。`ArchiveSettingsPage` は説明 + 入力 + 行の一覧を縦に積み、ヘッダの操作行（破棄 / 既定に戻す / 保存）は幅が足りなければ折り返す）
- compact の入力欄と選択欄は iOS Safari の focus 時ズームを避けるため 16px 以上にする（`text-md`。このテーマは色トークンに `base` があるため Tailwind の `text-base` は使えないので、`@theme` で 16px を `--text-md` に当てている）。設定ページのフォームは従来のサイズのまま（compact の「外観」のテーマ選択だけは 16px）
- 選択欄（select）は `SelectField` で包む。ブラウザ既定のドロップダウン矢印は余白を制御できず右端に寄りすぎるため、自前の chevron（右端から 10px、右余白 32px）に置換している。幅と伸縮は wrapper 側のクラスで決める

Composer の状態行（`client/src/components/composer/ComposerStatus.tsx`）は、活動テキスト / 使用中モデル / Context ゲージ / 圧縮ボタン を右端寄せの 1 行に置く。実行中と圧縮中はスピナーと経過時間を足す（起点は reducer の `runStartedAt` と `compactionStartedAt`、表記は `client/src/lib/elapsed.ts` の `formatElapsed`。詳細は [frontend.md](frontend.md#チャット状態とレンダリング)）。スピナーの出入りで活動テキストの左端は動く。

モデル名はピッカーを畳んでいても実効モデルが分かるように常時出す。表記は `ModelOption.name`（候補を引けなければ `provider/id`。切り詰めたときの確認用に `provider/id` を `title` に持つ）。候補に無いモデルのときは warn 色にし、入力欄の下の警告文と役割を分ける（色は気付き、文は理由）。未作成チャットでは「これから使うモデル」をピッカーと同じ優先順位で出す（導出は `client/src/lib/composerSettings.ts` の `deriveComposerSettings`。セッション作成後に `resync` が返す実効値へ切り替わる。[model-effort.md](model-effort.md#クライアント側の表示)）。

Context ゲージは compact でも絶対値 `(2.9k/272k)` まで出す（百分率だけではモデルの窓の大きさが読めないため）。行は `flex-wrap` で、活動テキストがあるときは下限幅 `min-w-40`（160px）を置き、モデル名 + ゲージ + 圧縮ボタンは 1 つの組にして右端へ寄せる。幅が足りなければ組が右寄せの 2 行目へ落ちる。ゲージだけを `shrink-0` で残してモデル名を活動テキストの隣に固定すると、狭い画面では活動テキストの幅が残らず 1 文字ごとに折り返して縦長になるため、幅を譲る側を組の折り返しに寄せる。モデル名が無いとき（セッションもモデルも未解決）は組がゲージだけになる。

手動圧縮のボタン（セッションがあるときだけ出す）はゲージの右、同じ組の中に置く。36px の `.icon-button` は `min-h-5.25`（21px）の行に収まらないため、この行専用の 20px の小さい variant（`styles/index.css` の `.composer-status-icon`）を使う。アイコンだけでは意味が伝わらないので `aria-label` を持ち、押せないときは `disabled` と `aria-describedby` で理由を示す。隣の「圧縮の注意」ボタンをタップすると、不可逆性と課金の注意（1 行）が状態行の下に開く（既定は畳み。hover に頼らない導線。タッチ利用者にも見える）。注意書きは `aria-describedby` の参照先として常に DOM にあり、開くまで視覚的にだけ隠す（`sr-only`）。

`min-h-5.25`（21px）は下限なので、折り返すと行は伸びる。実アプリの実測（モデル名 `DeepSeek V4.1 Flash` = 106.1px、ゲージ = 166.8px、活動テキストは `bash を実行中…` と `完了`）では、活動があるときは 390x844 = 39.5px（組が右寄せの 2 行目）、1440x900 = 22.5px（1 行）になり、landscape の 844x390 と低いウィンドウの 1440x500、tablet の 820x1180 も 22.5px、desktop の最小 720x900 だけ 39.5px（組が 2 行目）になる。折り返す境界はモデル名と活動テキストの長さで動き（実行中のスピナーも 1 行の可否に効く）、この環境では 500〜560px 付近。720x900 が 2 行目へ落ちるのは、状態行の幅が Sidebar の 252px を引いた main 列（実測 412px）で決まるため（docked のとき。左バーが overlay の帯では 252px 分がチャットへ回る）。

活動が無いとき（復帰直後や応答後の idle）は活動欄ごと出さないので、どの幅でも 21px の 1 行に戻る（空の活動欄を残すと、390x844 でも空行のぶんだけ 2 行目へ落ちる）。折り返すかは活動テキストの下限幅（160px）が決めるため、長い活動テキストでは 1 行に収まる幅でも活動テキストだけが 2 行へ折り返す（`実行中…（タブを閉じても処理は続きます）` は約 222px で、560〜600px 付近では組を同じ行に残したまま 39px になる）。モデル名が長いときは 2 行目の残り幅で名前だけを切り詰める（幅はフォントとモデル名で変わる）。

assistant のメッセージ列は `flex-1` で列幅いっぱい（desktop は `max-w-[min(760px,86%)]`、compact は `max-w-full`）に広げる。ツール履歴の `border-y` と、その行右端のコピーボタンの x 位置が、ツール出力の伸長やメッセージの内容量で動かないようにするため。user のメッセージ列は内容幅のまま右寄せを保つ（`flex-1` を付けるとバブル背景が列幅まで広がる）。

ツール履歴は代表ステータスを持たない（1 件の失敗で全体がエラーに見え、成功したコールの情報が消えるため）。畳んだ状態でも実行中だけは分かるようにサマリーへ `実行中` を出し、それ以外の位相は各コールの行が持つ。コールの行は入れ子の `<details>` で、開くまで引数と出力は出さない（件数が多い履歴でも一覧できる）。各コールは丸枠の面を持ち、失敗したコールは `border-danger/50` の枠と右端の `エラー` ラベルで示す。

スキル読み込み（`read` で basename が `SKILL.md`）はツールではなく、assistant バブル上部の専用バッジ（チップ行）で見せる（`client/src/components/chat/SkillLoadList.tsx`）。表記は `[skill] <name>[:start-end]`、既定は閉じで、展開すると解決後の絶対パス・行範囲・失敗理由（1行。ライブのカード出力が無ければ「読み込み失敗」）を確認できる（本文の展開は非ゴール）。成功 / 失敗 / 実行中（未確定）は色だけで区別し、名前は常に出す（実行中は展開に「読み込み中…」を出す）。4 件以上は 3 件 + `+N` に畳み、`+N` の展開で残りを出す。行範囲は `client/src/lib/skillLoad.ts` の `formatReadLineRange()` が pi ネイティブと同じ規則（`offset` 省略は 1 行目、`limit` 省略は最終行まで）で整形する。

スキル読み込みは `ツール履歴 N件` の件数・サマリー（`abbreviatedToolSummary` / `historyPreview`）・コピー本文（`client/src/lib/copy-content.ts`）にも含めない。表示側が `nonSkillToolCards()` で外してからツール履歴へ渡すため、スキルしかないバブルはツール履歴ブロックごと出ない（コピー本文の `#N` は UI の行番号と一致し続ける）。

同じ呼び出しがバッジとツールカードで二重に出ないよう、表示時に**全バブル横断**で `toolCallId` を突き合わせる（`skillBadgesOf()`）。表示位置は履歴（`ChatMessage.skillLoads`）を優先し、履歴に無いライブ分（`ToolCard.skill`）だけをカードのあるバブルへ出す。履歴ツールカード（`ChatMessage.tools`）にはスキル読み込みを載せず、バッジだけで表示する。resync は `messages[].tools` からカードと `toolBubbleIds` を再構築し、重複 ID の現在の `run.toolCalls` は run 側の状態で同じバブルを更新し、未投影分だけ最後の assistant バブルへ補う。これにより実行中 resync の後に届く `tool_end` も該当カードを更新できる。`runStart` / `runEnd` では次の run のイベントを誤適用しないよう索引を空にする。

ツール履歴の各コールの行の右端にある位相ラベル（実行中 / エラー）は `w-[3.25em]`（`text-3xs` で 29.25px）の固定スロットに右寄せ + `whitespace-nowrap` で置く。位相で文字幅が変わると（実測 実行中 27 / エラー 27.42px）、右隣のコピーボタンと左のコール名の truncate 境界が動くため。完了は空スロットにして、位相が違っても右端のコピーボタンの x を揃える。履歴のサマリーはスロットを持たず、実行中のときだけ `実行中` を置く（それ以外はラベルが無いので、右端のコピーボタンは常に同じ位置に着く）。幅を rem 基準にするとブラウザーの既定フォントサイズが 14px のときスロットが 24.5px まで縮んで最長ラベルが 2 行に折り返し、行高まで位相で変わる。そこでラベルの文字サイズに連動する em を使う。

メッセージ本文の下の時刻ラベルとコピーボタンは本文と同じ列の中の 1 行に並べる（時刻は `at` が無ければ出さない）。assistant 列の幅は本文とツール履歴で決まり、時刻ラベルの有無や長さでは動かない。内容幅で決まる user 列では、本文よりこの行が広い短文（例: 2 文字）で時刻ラベルの分だけ列幅が広がる。

## 作業先と作業フォルダの導線

プロジェクト配下の新規会話と未所属の新規会話は、左バーが overlay になる帯では main 領域だけで区別できない。そこで作業先をバーに常時出し、空状態の見出しと作業フォルダの導線を同じ判定で分ける。判定の正は `client/src/lib/chatScope.ts` の `chatScope()` で、セッション未作成は作成先（`selectedProjectId`）、セッションありは一覧の所属（`SessionSummary.projectId`）を使う。

- 表示は `Topbar` の作業先チップ（eyebrow の右。pill 形で、プロジェクト配下はフォルダアイコン + プロジェクト名、引けなければ「未所属」。`title` に作業フォルダ）、`CompactBar` のエージェント名の行の前置、`ChatArea` の空状態の見出しの 3 つ
- 空状態の見出しはプロジェクト配下で `${scope.label} で作業します`（作業先 + で作業します）、未所属で「プロジェクトの相棒です」（説明文と suggestion は両方で変えない）。判定の正はメッセージ 0 件なので、添付だけしたセッションも同じ規則で出る
- 作業フォルダの root（`sessionFilesRoot`）は選択中セッションの `payload.cwd`、セッション未作成では作成先プロジェクトの `cwd`。**セッションがあるときに `projectCwd` は渡さない**（`App` の呼び出しは `sessionId === "" ? selectedProject?.cwd ?? "" : ""` の 1 式に固定する）。選択待ちの `cwd === ""` に、作成先の別プロジェクトのツリーを出さないため。未所属の新規会話は root が決まらず（`sessionId` の採番が送信時）、トグル自体を出さない
- プロジェクト配下の新規会話は送信前からプロジェクトのツリーを出す（プロジェクトには登録時にディレクトリ実在が要る。[projects.md](projects.md)）。同一プロジェクトのセッションは同じ root を共有する

### 既定オープンと手動操作

desktop のパネル（`sessionFilesOpen`）と compact のシート（`sessionFilesSheetOpen`）は state を分ける。1 つにすると、desktop で開いたまま狭めたときに全画面シートが自動で開き、Effect で閉じても 1 フレーム遅れて `showModal()` と focus 移動が走る。

- desktop のパネルの既定（開）へ戻すのは 2 契機だけ。**(1) 起動時の初期化**（`!compact && selectedProjectId !== ""` の `useState` 遅延初期化。`projects` 一覧は見ず、一覧の到着を契機に開く Effect を作らない）、**(2) 利用者操作の新規会話の入口**（サイドバーの「新しい会話」/ プロジェクト行の ＋ / エージェント切替。そのときの作成先（引数の `projectId`、無ければ現在の `selectedProjectId`）がプロジェクトなら開、未所属なら閉。押すたびに既定へ戻す）。`App` の `handleNewChat` に 3 入口を寄せ、`useSessions` の内部フォールバック（開けない / 削除 / SSE 閉鎖 / リンク解決失敗）は `newChat` を直接呼ぶため既定を通らない
- compact のシートは既定オープンの対象外で、手動トグルだけで開く（`compact` へ入っただけでは開かない）。desktop へ戻ったとき（次に compact へ入ったときに自動で開かないため）、compact のまま `mainView`（設定ページかどうか）か `filesRoot` が変わったときに閉じる。**Effect ではなく描画中の同期**（前の描画の値と比べて state を更新する React のパターン）で閉じるので、`key={filesRoot}` の再 mount で `showModal()` が 1 フレーム走ることはない。監視するキーは `compact` / `mainView` / `filesRoot` の 3 つで、`route` オブジェクト全体は比較しない（`/s/<id>` の保留 URL を `/` へ畳むだけでは閉じない）。同じ root のままのセッション切替では閉じない
- レイアウト切替は互いの state に影響しない（desktop のパネルは compact 中も state を保ち、desktop へ戻ると同じ開閉で出る）。閉じる導線（パネル / シートのヘッダの ✕、シートの `Escape`）は押した面だけを閉じ、もう一方の state は変えない
- 作成先の選択（プロジェクト行 / `Chats` 見出し）は開閉 state を変えない。ただし未作成チャットでは表示中のチャットの作業先が作成先そのものなので、チップ / 見出し / root は直ちに変わる

| 操作 | チップ / 見出し | desktop のパネル |
| --- | --- | --- |
| 起動（作成先 = プロジェクト） | 一覧到着後にプロジェクト名（到着前は未所属） | 開（初期値）。root の解決後に見える |
| 起動（作成先 = 未所属） | 未所属 | 閉 |
| 起動（`/s/<id>` の復元） | 復元したセッションの所属（解決前は未所属） | 作成先の初期値を継承（下の例外） |
| サイドバーの「新しい会話」 | 作成先を維持 | 作成先がプロジェクトなら開、未所属なら閉 |
| プロジェクト行の ＋ | プロジェクト名 | 開 |
| エージェント切替 | 作成先を維持 | サイドバーの「新しい会話」と同じ |
| 内部フォールバック | 移った先の所属 | 変わらない |
| プロジェクト行の選択のみ（セッション表示中） | 変わらない | 変わらない |
| プロジェクト行の選択のみ（未作成チャット表示中） | 選んだプロジェクト名 | state のまま。root が変わって true ならそのまま出る |
| `Chats` 見出しのクリック（未作成チャット表示中） | 未所属 | root が消えて非表示（state は保持） |
| 添付・送信（セッション生成） | 変わらない | 変わらない |
| 既存セッションを開く | そのセッションの所属 | 変わらない |
| 設定ページ往復 | 変わらない | 変わらない（設定中は非表示、戻ると同じ） |
| desktop → compact | 変わらない | 非表示（state は保つ）。シートは開かない |
| compact → desktop | 変わらない | パネルの state で出る |

凡例: 表の「変わらない」は desktop のパネル state を指す。compact のシートは、設定ページへ入る / 出るか root が変わったとき（desktop へ戻ったときも含む）に閉じる。

**例外（起動時の `/s/<id>`）**: 初期値は作成先から決めるため、URL の対象が未所属や別プロジェクトでも、作成先がプロジェクトなら復元したセッションのパネルが開く。選択操作による上書きではなく、起動時に置いた初期値が（state を変えない既存セッションの復元にも）そのまま適用される。

### 非同期ロード中の表示契約

一覧の取得前や欠落した id では、チップ / 見出し / root が一時的に食い違い得る。**状態（開閉）は変えず**、次の値を取る。

| 状態 | チップ / 見出し | root |
| --- | --- | --- |
| `projects` 未取得（作成先 id はある） | 未所属 | `""`（`selectedProject` が引けないため）。一覧の到着後にプロジェクトの root へ変わる |
| `sessions` 未取得 / 一覧に無いセッション id | 未所属 | `payload.cwd`（GET の応答が先に来るため） |
| 所属プロジェクトが消えた / 解除された | 未所属（左バーの `groupSessionsByProject` と同じ規則） | `payload.cwd` のまま（フォルダは残る） |
| セッションの選択待ち（GET 中） | 応答まで元の表示（新規会話なら作成先、既存 A なら A の所属） | 応答まで元の root。応答後に選択先へ変わり、`key={filesRoot}` でパネル / シートが作り直される |

### 検証（実ブラウザー）

- プロジェクト行の ＋ → 見出しにプロジェクト名、チップにプロジェクト名、右パネルが開いてプロジェクトのツリーが出る（送信前）
- `Chats` 見出し → 新しい会話 → 見出しはキャッチコピー、チップは「未所属」、パネルは閉で導線も無い
- プロジェクト配下の新規会話で添付 → 送信前後でパネルの開閉と見出しが変わらない
- 手動で閉じる → 添付 → 送信 → 別セッション → 戻る、の各段階で勝手に開かない
- 送信に失敗したとき（サーバー未接続）に見出し / チップ / パネルが壊れない
- 設定ページ往復で開閉が変わらない。desktop でパネルを開いたまま狭めてもシートは開かず（一瞬も出ない）、desktop へ戻るとパネルは同じ開閉で出る
- desktop でパネルを開く → compact へ縮めてシートを開き ✕ / `Escape` で閉じる → desktop へ戻すと、パネルは開いたまま（シートの close がパネルの state を変えない）
- compact でシートを開いたまま設定ページへ入って戻ると開かない。シートを開いたままセッションを切り替える / root が変わる場合も閉じる。同じプロジェクト内のセッション切替（同じ root）では閉じない。`/s/<id>` が `/` へ畳まれても閉じない
- 選択待ち（GET 中）はチップ / 見出し / root が旧表示のままで、応答で切り替わる
- 内部フォールバック（壊れたセッションから移る / 削除 / SSE 閉鎖 / リンク解決失敗）でパネルの開閉が動かない
- 開発ビルド（StrictMode）で開き直し・二重オープンが起きない
- compact（390x844 / 844x390）: 作業先が出て truncate が壊れない

## チャットの自動追従と最下部ボタン

メッセージ領域は「最下部付近にいるときだけ」最新へ追従する。読み返している最中（追従が外れている間）は、応答のトークンが届いても位置を動かさず、下端中央のボタンを「最新へ戻る」導線にする。判定は `client/src/lib/chatScroll.ts` の純関数が正で、state / ref と Effect は `ChatArea` が持つ。

| 遷移 | きっかけ |
| --- | --- |
| true → false | 位置が減る scroll（ユーザーが上へ戻した）で最下部からの距離が 48px を超えた |
| false → true | 48px 以内へ自分で戻る / ボタン押下 / 送信（`sendSeq` の増加）/ 会話の切替（`sessionId` の変化。`""` からの遷移 = 新規チャットの作成も含む） |
| true のとき | 内容・容器のサイズが変わるたびに最下部へ揃える。レイアウト起因の `scroll` で離れたときもその場で書き戻す |

- しきい値は `CHAT_FOLLOW_THRESHOLD = 48`（px）。本文の行高は `styles/index.css` の `.md` で 22.75px（13px × 1.75）なので 2 行ぶんを取る。丸め誤差や添付の遅延ロードのような小さなズレでは外れず、意図的な上スクロールでは外れる目安で、ホイール量は機器と設定に依存するため「1 ノッチで必ず外れる」は保証しない
- 送信はバブルの形（件数と末尾の role）から推測せず、`ChatState.sendSeq` の増加で拾う。増えるのは `localUser`（表示中の会話への送信のローカルエコー）だけで、履歴を全置換する `resync` では変えない（再接続で件数が増えて末尾が user でも送信と誤読しない）。`newChat` は `nextId` / `runEndSeq` と同じく引き継いで単調に保つ（減少を「送信」と誤読させない）。post が失敗して echo を戻しても減らさない（最下部に居続ける方が都合が良く、失敗の理由は状態行に出る）
- 会話の切替は `""` からの遷移も含めて最下部へ揃える。新規チャットの作成は送信だけでなく添付のアップロードでも起き、空のチャットでも内容が viewport を超えればスクロールできるため、例外を作らない
- ボタン押下と追従の書き込みは instant（`scrollTop = scrollHeight`）。`behavior: "smooth"` はアニメーション中の `scroll` で追従が戻る競合と `prefers-reduced-motion` の分岐が増えるため使わない
- 追従を外せるのはユーザーが上へ戻した（位置が減る）ときだけ。位置が増える `scroll` は、自分の snap の代入か、レイアウトの再折り返しでブラウザーが動かした位置で、どちらもユーザー操作ではない。右パネルを開くとチャット幅が 1188 → 828px に変わって本文が折り返し直り、Chrome のスクロールアンカリングが `scrollTop` を増やして最下部から離れた位置（実測 `dist 136〜227`）の `scroll` を配る。この `scroll` は同じフレームの `ResizeObserver` callback より先に届くため、距離だけで判定すると追従が外れ、直後の callback も `follow` が false で書き戻さない（実測: 追従中に開くと 70/71 で外れ、開→閉の「開いた瞬間」も必ず外れる）。`resolveScrollFollow()` が向きで判定し、追従中に離れていたらその場で書き戻す（snap の代入で書いた位置を控えて照合する旧方式は、自分が書いた位置しか除外できずこの経路を塞げない）
- `overflow-anchor: none` でアンカリングを止める案は採らない。注入すれば 8/8 → 0/8 で欠陥は消えるが、読み返し中にレイアウトが変わったときの読み位置を保つ役目（ブラウザー任せだが実測で効いている）を失うため、判定側で除外する
- 追従中は `scroll` の向きを見るだけで、距離の判定は位置が減る `scroll` に限る。ウィンドウリサイズ（1440 → 820、同じ再折り返しが起きる）は実測 0/24 で外れず、in-page の列幅変更（右パネルを開く）だけが引き金だった
- `ScrollToBottomButton` は追従中とメッセージ 0 件（suggestion 表示）では出さない。`aria-live="polite"` の外側（section の後ろ）に `absolute bottom-4 left-1/2 -translate-x-1/2` で浮かせ、見た目は `client/src/components/chat/ScrollToBottomButton.tsx` が持ち、位置だけを呼び出し側の className で渡す
- Effect は 内容（`bubbles`）/ `sendSeq` / `sessionId` / `visible` / `ResizeObserver`（section と本文ブロック）の 5 つ。DOM への書き込みは `visible` を見て follow を立ててから書く `snapToBottom()` に閉じ、非表示中は書かない（設定ページ中は祖先が `display: none`）。observer は `visible` の間だけ張り、callback でも `visible` と 0 サイズ（非表示中の通知）を除外する。callback からサイズを変える更新はしない（loop 警告を避ける）
- 非ゴール: スムーススクロール、新着のドット / 件数バッジ、位置の永続化（リロード・会話を跨いだ復元）、設定ページ往復後の読み位置の復元、resync をまたいで同じメッセージを見続けること（全バブルの id が振り直される）、「一番上へ」ボタン

### 追従の検証

`client/test/chatScroll.test.ts` がしきい値の境界（ちょうど / 端数 / 内容が収まる / 空）と `resolveScrollFollow()` の判定（位置が増えるレイアウト起因の `scroll` では外さず書き戻す / 位置が減る `scroll` は 48px ちょうどまで追従 / 読み返し中は 48px 以内へ戻ったときだけ再開）、`ChatArea` の配線（follow で gate されている・`visible` 中は書かない・向きの基準 `lastTopRef` を snap の代入でも更新する・ボタンの `aria-label`）を、`client/test/chatReducer.test.ts` が `sendSeq` の増減（`localUser` だけ / `resync` / `newChat`）を固定する。スクロール・ResizeObserver・フォーカスは jsdom 無しのテストでは検証できないので、実ブラウザーで次を確認する。

- ストリーミング中に上へスクロールしても引き戻されず、ボタンが出る（ホイール / トラックパッド / `PageUp`・`↑`・`Home` / タッチ）
- 追従中はユーザー操作なしにボタンが出ない（大きな tool 出力が続く場面）
- snap の直後に上へスクロールしても引き戻されず、ボタンが出る（向きの判定がユーザー操作を取りこぼさない）
- 追従中（`dist ≦ 48`）に右パネルを開閉しても `dist ≦ 48` のままで、ボタンが出ない（開→閉の「開いた瞬間」も含む。連続開閉 / ストリーミング中 / `dist 30` からの操作も同じ）
- ボタンで最下部へ戻り、以後は追従が再開する。48px 以内へ自分で戻したときも（ボタン無しで）再開する
- 読み返したまま送信すると最下部へ戻る（キュー送信も同じ。post に失敗したときも最下部に居続け、理由は状態行に出る）
- 会話の切替で最新位置が出る（`A → "" → B`。新規チャットの作成は送信 / 添付のどちらでも揃う）
- 再接続（SSE の resync）で強制的に最下部へ飛ばない
- 追従中は最下部から離れない（コンポーザの伸縮 / 右パネルのドラッグ / リサイズ）
- 設定ページを往復したときの位置（追従中は最新。外れているときは実測で `scrollTop` が保持された（`8474 → 8474`）が、アプリは復元しないので保証はしない）
- メッセージ 0 件（suggestion 表示）ではボタンが出ない。キーボードでボタンへ到達でき、既存の `Escape` を妨げない

## 入力欄の Enter（送信と改行）

`Composer` の textarea の Enter は、モードと IME の状態で分ける。判定は `client/src/lib/composerKeys.ts` の `shouldSubmitOnEnter()` が正で、true のときだけ `preventDefault` して送信する。

- IME の変換確定 Enter では送信しない。`isComposing` に加えて `keyCode === 229` も見るのは、`compositionend` が keydown より先に届くと `isComposing` が false のまま確定の Enter が来る実装があるため（MDN の keydown の注記）。この 2 つで取り切れない順序（`keyCode` が 13 で composition の直後に来るもの）は残るので、実機でログが取れたら追記する
- desktop は通常の Enter で送信、`Shift+Enter` で改行（従来どおり）
- compact は Enter を改行に残す。タッチ入力では `Shift+Enter` を前提にできず、改行の逃げ道が無いため。送信は送信ボタンに寄せ、`preventDefault` をしないので変換確定も既定の改行処理もブラウザーに任せる（compact の入力欄のヒントにも Enter 送信を出さない）
- `enterkeyhint` はモードに合わせる（desktop = `send` / compact = `enter`）。キーのラベル / アイコンのヒントなので動作は変えず、ソフトキーボード上の表示だけを揃える

## 設定の編集フォーム（エージェント / スキル）

設定 → エージェント の編集列（`client/src/components/agent-settings/`）は、可変長の「定型プロンプト」「スキル」を持つため、確定操作の位置が件数に比例して下がる。これを避けるため次のように組む。スキル（`skill-settings/SkillEditorForm.tsx`）は項目が固定なので、シートのときだけこれに揃える。

- エディタ列は `<form>` を縦 flex の 2 段にし、上段 = スクロールする本文（`flex-1`）、下段 = 常時表示のアクション行（左: 削除 / 右: 保存）にする。削除は編集中だけ出す。ヘッダ（`SettingsPageLayout` の `actions`）に置かないのは、compact のヘッダが ナビ + タイトル + アプリに戻る の 3 要素で、破壊操作が保存の隣に並ぶため。`flex-1` は grid item では無視されるので、ページの grid 行でも [シート](#compact-の詳細シート) の flex 列でも同じ形で高さを埋められる
- スキルのフォームは 2 段にするのをシートのときだけにする。desktop は従来どおり本文（`max-w-2xl`）の最後に操作行を置き、保存を全幅にする
- 本文は `@container`（`@3xl` = 768px）で、コンテナ幅が足りるときだけ 2 カラム（左: 名前 / 説明 / 役割・基本指示 / Model・Effort、右: スキル / 定型プロンプト）にする。viewport ではなくコンテナで判定するのは、エディタ列の幅が「サイドバー 252px + 一覧 248px」を引いた残りで決まり（左バーが docked のとき）、compact では一覧が上に積まれて本文が全幅になるため。1440x900 は本文 約 908px で 2 カラム、1280x800 は 約 748px で 1 カラムになる（どちらも 保存 / 削除 は本文の外にある）
- 本文の中央寄せ上限は `max-w-5xl`（1024px）。1440x900 では効かず、極端に広いウィンドウでフィールドが横に伸びきるのを防ぐだけに置く
- アイコンは プレビュー（`AgentIcon` の `preview`）+「画像を選ぶ」/「解除」の 1 行にし、保存は既存の「保存」ボタンで他の項目と同じ要求に乗せる（ファイルを選んだ時点では送らない。未保存の下書きとアイコンが食い違う状態を作らないため）。canvas の縮小とエンコードは DOM 依存なので `client/src/lib/agentIconFile.ts` に閉じ、純関数（縮小サイズ / data URL の検証 / `agentId` の解決）は `client/src/lib/agentIcon.ts` に置く
- 右カラムは最大 360px なので、定型プロンプト（`SuggestionsEditor`）の 1 件は「ラベル + 削除アイコン」の行と「プロンプト」の行の 2 段にする。フィールド見出しは placeholder へ寄せ、読み上げ用の `aria-label` は残す。スキル（`SkillSelector`）は見出しに「割り当て中 N / 全 M」を出し、一覧だけを `max-h-72` の内部スクロールにする（行の説明は 1 行 truncate + `title`）。組み込みスキルはその下に「組み込み（全エージェントで常時有効）」の小見出しで、チェック済み・無効の行として出す（`skillIds` では外せないため。データは `GET /api/agents` の `builtinSkills`）。ここで `wide:`（viewport 900px）を使うと狭いカラムの中で常に真になり横並びが潰れるので、カラム内は縦積みに固定する
- 2 カラムになると役割 / 基本指示の textarea の幅が狭くなるため、行数と最小の高さを増やして縦を補う（2 カラムでも本文の高さが表示領域を超えない範囲で）
- ビルトインの汎用アシスタントを選んだときはフォームを出さず、`BuiltinAgentPanel` の説明だけを出す（編集も削除もできないため。見出しの出し方はフォームと同じで、ページは本文の先頭、シートはヘッダに出す）
- 一覧の読み取り専用スキル（共通 / 組み込み）を選んだときもフォームの代わりに `ReadOnlySkillPanel` の本文ビューを出す（編集・削除はできない）。組み込みは一覧の `body` をそのまま出し、ファイルスキルは選択のたびに `GET /api/files/preview` で本文を取り直す。選択を切り替えた 1 フレーム目と、同じ行を押し直したときの両方で取り直せるよう、ページ側で `key` に `path` と選択の世代を渡して作り直す
- カタログスキルは一覧で選ぶと `CatalogSkillPanel` の閲覧ビューを出し、`編集` でフォームへ入る（新規作成はフォームへ直行）。閲覧ビューと編集フォームの切替は 1 つの `mode` で持ち、`編集` の開始時に現行のカタログから下書きを作り直し、`キャンセル` は未保存の差分があるときだけ `window.confirm` を出してから破棄する（下書きの初期化条件に `mode` を含めるのは、同じスキルで view → edit に変わっても初期化を走らせるため）

## スキル詳細パネル（閲覧ビュー）

カタログスキルの閲覧ビュー（`CatalogSkillPanel`）と読み取り専用スキルの本文ビュー（`ReadOnlySkillPanel`）は、`client/src/components/skill-settings/SkillDetailPanel.tsx` の共通枠で組む。

- 先頭は**操作行**（左: `SKILL` + 見出し / 右: そのパネルの操作）。ファイルスキルは「本文 / ファイル」のタブ、カタログスキルは `編集` を置く。見出しは page のときだけ出す（compact のシートはヘッダに同じ見出しが出る）
- 操作行の下は `min-h-0` + `overflow-y-auto` の残余領域にし、本文タブはその中だけがスクロールする。ファイルタブは残余領域いっぱいへ `FileBrowser` を直接広げる（本文のスクロール枠の中へ入れると入れ子スクロールになる）。通常の viewport ではどちらもスクロールは出ないが、`FilePreview` の `min-h-40` を含む `FileBrowser` の下限を下回る極端に低い容器では、この残余領域だけがスクロールしてクリップしない
- ファイルタブは初回に開いたときだけ mount し、以降は `display` で隠して保持する（タブ・本文・スクロール位置を保ち、行き来しても取り直さない）
- ファイルタブの `FileBrowser` はダウンロード / 削除 / リネームの導線を出さない（`readOnly`）。ツリーとプレビューの並びは `FileBrowser` 側の container 判定に従う（1440x900 は本文 約 908px で横並び、820x1180 と 390x844 は縦積み、844x390 は幅 844px なので横並び）
- 本文のコピーボタンは表示と同じ生テキストを常時表示でコピーする（`FilePreview` の正規化コピーとは別。`api-catalog.md`）

## compact の詳細シート

compact の 設定 → エージェント / スキル は「一覧（ページ）+ 編集（全画面シート）」に分ける。1 列に積むと、選択のためだけの一覧が常時 `30vh` を占め、編集フォームの表示領域が 390x844 で 381px まで落ちる（シートなら約 664px）。

- ページは一覧だけを出して全高を使う（`DefinitionList` は compact で `max-h-[30vh]` を付けない）。行の選択と「新しい〜」で `SettingsDetailSheet`（モーダル dialog）が全画面で開く
- シートは ヘッダ（eyebrow + 見出し + 閉じる）/ スクロールする本文（[編集フォーム](#設定の編集フォームエージェント--スキル)）/ 固定アクション行 / note の 4 段。本文と操作行はページと同じフォームを渡すので、フォーム側の見出しはシートのヘッダへ出す
- 編集の下書き（フォームの state）はページが持つ。compact と desktop をまたぐとフォームの container が変わり（ページ ⇄ dialog）、フォーム自身が state を持つと unmount で未保存の入力が消える。編集対象・カタログ・`mode` が変わったときだけ初期化する（`編集` の開始で現行のカタログから作り直し、`キャンセル` は確認後に破棄する）
- 保存 / 削除が成功したらシートを閉じて一覧へ戻る（結果はページの note 行に出る）。失敗したときは開いたままにし、同じ note をシートの最下段へも出す（背面の note 行は見えないため）。note の位置をページと揃えるのは、閉じたときに同じ場所で続きを読めるようにするため
- `Escape` は シート → ページ → チャット の順。シートは `<dialog>` の標準挙動で閉じ、`keydown` を `window` へ伝播させない（伝播させると同時に `App` がチャットへ戻す）
- 境界は compact（幅 < 720px または高さ < 560px）に限る。desktop は幅 900px 未満で 1 列に積まれるが、`ProjectDialog` と同じく「全画面にするか」の判断は compact に揃え、desktop の見え方は変えない
- 開閉はページが持つ（`sheetOpen`）。`editingId` と分けるのは、`null` が「新規」も意味して閉じた状態と区別できないため。desktop の行選択では開かないので、幅を狭めて compact になっても勝手には開かない
- シートの見出し（`SettingsDetailSheet` の title / aria-label）は表示中の面に連動させる。読み取り専用スキルはスコープ名、カタログスキルは view = `スキル` / edit = `スキルを編集`、新規 = `新しいスキル`（閲覧ビューに `スキルを編集` を残さない）

## サイドバー

サイドバーは nav / settings の 2 モードを持ち、モードは URL から導出する（`NavSheet` は同じ `Sidebar` を開くだけなので、desktop と compact のどちらでも切替が保たれる）。実装は `client/src/components/Sidebar.tsx`。overlay（compact と 1200px 未満の desktop）では**モードの切替（設定 / アプリに戻る）ではドロワーを閉じず、セクションの選択で閉じる**（既存契約。切替で中身が入れ替わると押した項目が unmount するため、focus はドロワーの中の先頭操作要素へ引き戻す）。`Escape` は 詳細シート → nav ドロワー → チャット の順で、開いているもの 1 つだけが受ける。

置き方は幅だけで決まる（`resolveSidebarPlacement`）。docked（viewport >= 1200px の desktop）は左カラムに常駐し、開く導線は無い。overlay（それ以外）は ☰（`Topbar` / 設定ページのヘッダ / `CompactBar`）から `NavSheet` を開く。閉じるときの focus は、起点がまだ使えるならそこへ戻す（`isConnected` は真でも `display: none` の真であることがあるため、「移せたか」を `document.activeElement` で確かめる）。使えない場合は docked になった `Sidebar` の先頭操作要素、次にいま表示されている ☰ へ移す（1200px を跨いで ☰ ごと消えたときと、設定ページへ移って ☰ が隠れたときの両方を拾う。`body` へは落とさない）。

- docked ⇄ overlay を跨ぐと `Sidebar` は unmount / mount するので、その内部 state（プロジェクトの折りたたみ）はリセットされる（compact の drawer と同じ挙動。永続化は非ゴール）
- 同じく跨いだときに開いていた `NavSheet` は閉じる（左バーが docked に戻るため）。描画の条件にも `!sidebarDocked` を入れて、docked へ戻ったフレームで両方を重ねない

### nav モード

上から ブランド / 「新しい会話」/ `Projects`（`New Project` + プロジェクト行）/ `Chats` / フットノート / `設定`（下部固定。設定ナビの項目と同じ行の寸法）。

- プロジェクト行は フォルダアイコン + 名前 + cwd 相対パスの副次表示 + 折りたたみ chevron + ホバーの「＋」「削除」。行のクリックでそのプロジェクトを選択し、配下セッションは `SessionRow` をインデント表示する
- 行の右端の操作は `client/src/components/sidebar/RowAction.tsx` が寸法（`size-7` / 角丸 / 文字色）とホバー端末での出し分け（`can-hover` では隠し、行のホバーで出す。タッチ端末では常時表示）を持ち、プロジェクト行とセッション行で共有する。削除の印はどちらもゴミ箱（`TrashIcon`）で、設定 → エージェント / スキルの削除と同じ絵にする。赤くなるのはボタン自身のホバーだけで、行のホバーでは色を変えない（プロジェクト行は折りたたみ / ＋ / 削除を並べるため、行のホバーで 1 つだけ赤くなると何を指すか読めない）
- 選択中プロジェクトは「新しい会話」の**作成先**で、開いているセッションの所属とは一致しないことがある。そのためプロジェクト行のハイライトは弱く（`accent-wash/60` と薄い枠）、セッション行（`accent-wash` と濃い枠）と区別する。**`Chats` 見出しも同じ選択**を持ち、押すと作成先を未所属へ戻す（未所属を選んでいるときは見出しが弱いハイライトになる）。プロジェクト行は選ぶだけでは解除できないため、未所属へ戻す導線はここだけ
- 並び順はプロジェクトが作成順、配下セッションと `Chats` が `lastUsedAt` 降順。グループ化は `client/src/lib/sessionsByProject.ts` の純関数が担い、未知の `projectId`（破棄直後など）は `Chats` へ寄せて一覧から消さない
- プロジェクトの追加は dialog（`ProjectDialog`）で行う。新規作成は親ディレクトリ + 名前、既存登録は対象ディレクトリを選び、どちらも `GET /api/files` を辿って選ぶ（root は登録できない）。削除の confirm は配下セッション数を示し、ディレクトリが残ることも明示する

### settings モード

「アプリに戻る」+ エージェント / スキル / ファイル / アーカイブ / 外観 / ランタイム / 通知 の 7 項目。項目は左にアイコンを置く 30px の行（行間 4px、外枠なし）で、メイン領域のページを切り替える（メイン領域の切替と mode の対応は [モードごとの構成](#モードごとの構成)）。開いている項目は `bg-accent` の塗りで示し、内側の一覧（エージェント / スキル）の選択は `accent-wash` にしてページの選択と区別する。行の寸法は `client/src/components/MenuItem.tsx` が 1 箇所で持ち、内側の一覧（`DefinitionList`）と共有する。テーマ切替の入口は「外観」に一本化し、`Topbar` とドロワーのカードには置かない。

一覧は `Projects` と `Chats` をまとめて 1 つのスクロール領域にし、`設定` は下部に固定する。desktop では高さが足りないとき、compact では drawer 全体のスクロールで全項目へ到達できる。

## 検証

自動テストは `client/test/layout.test.ts` がモード判定の境界と、左バーの配置（1200px の境界・compact は常に overlay）を、`client/test/sidebarOverlay.test.ts` が左バーの ☰ の出し分け（`Topbar` / 設定ページのヘッダの描画、overlay のときだけ出す）と App の配線（1 カラム ⇄ 2 カラム・`mainWidth` の渡し分け・docked へ戻ったらドロワーを閉じる・焦点の戻し先のフォールバック）を、`client/test/sessionsByProject.test.ts` がプロジェクト別のグループ化（未所属の分離・並び順）を、`client/test/route.test.ts` が pathname と画面の対応（大文字・末尾スラッシュ・percent encoding・不正な入力の畳み方、`/s/<id>` の選択待ちの入口と畳み）を、`client/test/notifyToggle.test.ts` が会話の通知トグル（新規チャットの先行選択と作成要求時のスナップショット、会話ごとの直列化と後発優先、配信できない理由ごとの注記、配信可否と切替の禁止の使い分け）と、バーに描かれる ☰ / 🔔 / 📁 の順と `.icon-button`（components 層）の見た目を、`client/test/settingsNav.test.ts` が設定ナビの 7 項目と保存された最後のセクションの解決を、`client/test/archiveSettingsPage.test.ts` が設定 → アーカイブの描画（未設定 / 上書き / 明示空 / note のエラー）と配線（PUT / DELETE と app 状態の反映）を、`client/test/fileTabs.test.ts` がプレビューのタブ（開閉・上限・選択の遷移・同名タブのラベル・保存値からの復元）を、`client/test/filePreviewTabClose.test.ts` がタブの中クリック（`button === 1` だけ / タブの箱で受ける / down 側の既定動作を止める）を、`client/test/settingsDetailSheet.test.ts` が compact の詳細シートの `Escape` の順序（モーダルで開く / 伝播を止める / `App` は bubble で受ける）を、`client/test/skillLoad.test.ts` がバッジの行範囲整形と状態（実行中 / 成功 / 失敗）、ライブ / 履歴 / resync の統合（全バブル横断の二重表示排除）、ツール履歴の件数・サマリー・コピーからの除外と、`react-dom/server` での描画（バッジ / 畳み方 / スキルしかないバブル）を、`client/test/sidebarRowAction.test.ts` が行の右端の操作（プロジェクト行とセッション行が同じ `RowAction` を使うこと、削除が `×` ではなくゴミ箱であること、読み上げ名とホバー端末での出し分け）を、`client/test/composerEnter.test.ts` が入力欄の Enter の判定（IME 変換中 / `keyCode` 229 / desktop / compact）と、モードごとの `enterkeyhint` を、`client/test/sessionFilesPanel.test.ts` が右パネルの幅の境界（1920〜720px の min / max、720px の `min == max`、overlay 配置での上限）と clamp・キーボードの 1 歩・保存値の parse（壊れた値 / bounds 外 / 保存領域が使えない環境）と、ハンドルの配線（終了経路の集約・移動ゼロで commit しないこと）を固定する。手動圧縮の状態行は `client/test/composerStatus.test.ts`（ゲージの右の配置、小さい variant、`aria-describedby` と注意書きの導線、押せないときの理由）と `client/test/composerSettings.test.ts`（実効 busy と通信中での活性）、応答の適用は `client/test/sessionActions.test.ts`（操作世代と選択のガード）が固定する。作業先と作業フォルダの導線は `client/test/chatScope.test.ts`（作業先の解決: 未作成 / セッションあり / 名前が引けない / 解除後 / 一覧未取得）、`client/test/sessionFiles.test.ts`（root の可用性と既定オープンの純関数）、`client/test/chatScopeWiring.test.ts`（バーと空状態の描画・既定オープンを適用する契機が「起動の初期化」と `App` の `handleNewChat` だけであること・3 入口の配線と内部フォールバックが通らないこと・compact のシートを描画中の同期で閉じること・閉じる導線が押した面だけを閉じること・landscape の作業先行の収縮と省略）が固定する。チャットの自動追従は `client/test/chatScroll.test.ts`（しきい値の境界・`resolveScrollFollow()` の向きの判定・`ChatArea` の配線）と `client/test/chatReducer.test.ts`（`sendSeq` の増減）が固定し、実ブラウザーでの受入項目は[チャットの自動追従と最下部ボタン](#チャットの自動追従と最下部ボタン)に列挙する。client test の方針は jsdom を足さずに DOM に依存しないことで、純粋なロジックに加えて `client/test/eventInStateUpdater.test.ts` のようなソース走査型の回帰テストも置く。見た目は次の viewport で確認する。

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
