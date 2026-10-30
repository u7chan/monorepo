# ファイルツリー

ファイルツリーの表示（どの画面がどの root を使うか・隠す行・開閉・reveal）と、メッセージ / 入力欄からのファイル参照。本体は `client/src/components/FileBrowser.tsx`、参照の判定は `client/src/lib/fileRef.ts`、面の座標解決は `client/src/lib/fileRefOpen.ts`。プレビューの描画は [file-preview.md](file-preview.md)、行の操作は [file-actions.md](file-actions.md) を参照する。

## 画面と root

ツリーとプレビューの本体は `client/src/components/FileBrowser.tsx` で、root を props で受け取る。同じ実装を 4 面が別の root で使う。

| 画面 | 外装 | root | 出す条件 |
| --- | --- | --- | --- |
| 設定 → ファイル | `FileTreePage`（`SettingsPageLayout` + ヘッダ + タブ） | ワークスペース root 固定（`cwd=""` → `"."`） | 常時（タブの一方はダウンロードの除外） |
| チャットの右パネル | `SessionFilesPanel`（ヘッダ + 閉じる） | 選択中セッションの作業フォルダ（`payload.cwd`） | desktop のチャット画面で、作業フォルダがあるときだけ（`client/src/lib/sessionFiles.ts`） |
| チャットのスキル面 | `SessionFilesPanel` / `SessionFilesSheet` のスキルモード（`SkillFilesContent`） | 参照の絶対パスから導いた `.agents/skills/<name>`（ワークスペース root 相対） | 共通スキル配下の絶対パスの参照をクリックしたときだけ（[面のモード](#面のモード作業フォルダとスキル)） |
| 設定 → スキルのファイルタブ | `FileSkillPanel`（`SkillDetailPanel` のファイルタブ） | SKILL.md の親ディレクトリ（root 相対。`client/src/lib/fileSkills.ts` の `fileSkillDir`） | `scope !== "builtin"` かつ root 相対の `.../SKILL.md` の親が取れるときだけ（組み込みの仮想パスと root 外の絶対パスは出さない）。**ダウンロード / 削除 / リネームは `readOnly` で出さない（パスのコピーは出す）** |

- `FileBrowser` は root が変わると復元・取得・保存をやり直す必要があるので、呼び出し側が `key` を張り替える。パネルはセッションの切替で `SessionFilesPanel` ごと入れ替える（`FileBrowser` の `root` は mount の間一定）。スキルのファイルタブは選択したスキルごとに `FileSkillPanel` ごと入れ替え、初回にタブを開いたときだけ `FileBrowser` を mount する（以降は `display` で隠して保持する）。チャットのスキル面も `FileBrowser` の `key` を skill root にして、root の切替で remount する
- 取り直しの入口は外装の「再読み込み」と run_end で共通の `reloadToken` に集める（`SessionFilesPanel` は ヘッダの「再読み込み」の回数 + `ChatState.runEndSeq` の合計を渡す）。**チャットのスキル面はヘッダに「再読み込み」を持たず、`runEndSeq` だけを渡す**（設定 → スキルのファイルタブは自動の取り直しを持たない）。mount 時の token では撃たない（root の切替は `key` が扱うため）。run_end は描画された `runStatus` の差ではなく、reducer が `run_end` で進める `runEndSeq` を起点にする（`run_start` と `run_end` が同じバッチで届くと React は 1 回の描画にまとめるため、画面側では `running` を観測できず取りこぼす。SSE が切れて `resync` で復帰したときも、`running` を抜けていれば reducer が進める）。実行中の `tool_end` ごとの更新はしない
- `GET /api/files` の path は root を前置する（`fileTreeFetchPath`）ので、パネルは `payload.cwd`（プロジェクト所属なら登録ディレクトリ、未所属なら所属スペースのスクラッチ）を root として扱う。サンドボックス / API は変えない（同じファイルを設定 → ファイル からも開ける）
- **作業フォルダ面（右パネル / sheet）だけが `.git` を行ごと隠す**（[隠す行](#隠す行)）。設定 → ファイル とスキル面（設定 → スキルのファイルタブ / チャットのスキル面）は隠さない

## 作業フォルダ面の帯（パスと ⋯）

帯のパスは末尾優先で見せ、パスの ⋯ からセッション ID と絶対パスをコピーできる（`client/src/components/WorkFolderPathMenu.tsx`）。

- **パスは「省略される前置き」と「幅を確保する末尾」に分ける**（`client/src/lib/sessionFilesPath.ts` の `splitWorkFolderPath`）。末尾の段数は会話の種別だけで決める（プロジェクト所属は登録ディレクトリ名の 1 段、未所属は `sessions/<sessionId>` の 2 段。未取得は 1 段に倒す）。セッション ID の正規表現でパスを解析しない。末尾は `shrink-0`、前置きだけを `truncate` するので、狭い幅でも ID は最後まで残る
- **パスと ⋯ は折り返さない 1 つの組にし、省略前のパス全体 + ⋯ + 間隔を実測して帯の文脈の最小幅にする**（`TabToolbar` の `contextMinWidth`）。固定の内側幅を前提にせず、組が入り切らない幅では組ごと全幅の段へ落ちて [再読み込み] が次の段へ回るので、**短いパスは省略されない**（`min-w-0` のままだと文脈が 0 まで縮み、細い段に残ったパスだけが切れて ⋯ が落ちる）。段の幅すら超える長いプロジェクト名では末尾だけ `truncate` に落ちる
- **⋯ の項目は「セッション ID をコピー」→「絶対パスをコピー」の 2 つ**で、行の ⋯（`FileRowActionKind`）には出さない。セッション ID は `envScope.sessionId`、絶対パスは行と同じ `fileTreeAbsolutePath(rootCwd, root, ".")`（root が `.` のときは `rootCwd` 自身）で作り、取れない値は別の値で代替しない
- **片方だけ取れないときは項目を disabled にして理由を 2 行目へ出す**（会話がまだ無い / ワークスペースの絶対パスが未取得）。**両方取れないときは ⋯ を出さず、理由をパスの下へ常設する**（全項目 disabled を `RowMenu` へ渡さない。[行の操作メニュー](file-actions.md#行の操作メニュー) の「有効な最初の項目へ focus」の前提を崩さないため）
- コピーは `client/src/lib/copyToClipboard.ts` を通す。成功は ⋯ を 2 秒チェックに替え、`role="status"` で項目ごとの文言を読み上げる。失敗はパスの下の `role="alert"` の段（`basis-full` + `min-w-0`）に内訳を折り返して出し、8 秒で消す（[パスをコピー](file-actions.md#パスをコピー) と同じ見せ方。長い非改行文字列でも親幅で折り返し、全文を読める）
- **同じ cwd の会話切替ではパネルが remount されない**（`key={filesRoot}`）ので、コピーの結果を所有する `WorkFolderPathMenu` を `envScope.sessionId` で key にして張り替える。`useMessageCopy` の unmount 後始末が世代を進めるため、前の会話で始めたコピーの成否は次の会話の表示に適用されない
- スキル面のパス表示は対象外（セッション ID を持たない面）。同じ帯に ⋯ を 2 つ置かない

## 隠す行

`FileBrowser` の `hiddenNames`（既定 `[]`）で、名前が一致する行を一覧から除く。渡すのは**作業フォルダ面（`SessionFilesPanel`。desktop の右パネルと singleColumn の sheet で同じ）だけ**で、`client/src/lib/sessionFiles.ts` の `SESSION_FILES_HIDDEN_NAMES = [".git"]` を渡す。**設定 → ファイル とスキル面（設定 → スキルのファイルタブ / チャットのスキル面）は渡さず、`.git` を含めて全部見える**（見たいときの逃げ道）。

- **隠すのは名前一致だけで、種別も階層も見ない**（`visibleFileTreeEntries`）。`.git` は worktree / submodule ではディレクトリではなくファイルなので、種別で判定すると隠れ残る。階層を見ないのは、一覧がその階層の子だけを返すため、名前一致がそのまま「どの階層の `.git` も隠す」になる（ネスト repo を展開したときの `.git` も同じノイズになる）。部分一致はしない（`.gitignore` / `git` は残る）
- **フィルタは一覧を state へ入れる前に行う**（`getFiles` の直後）。隠した枝を state に持たないので、開いていたとしても `.git` の中身を取得しない（行が出ないまま往復だけが増えるのを避ける）。保存値（`filePreviewStore`）から復元する展開状態も `visibleFileTreeDirectories` で落とす（以前の版で開いていた `.git` を次の mount へ持ち越さない）。**reveal（ファイル参照のファイル・パンくず）も隠す名前を含むパスでは祖先を開かない**（行が無いので、開くと不可視の展開が state と保存値に残るだけになる。判定は `isHiddenFileTreePath`）
- **取得済みの一覧は `hiddenNames` を変えても絞り直さない**（一覧は state へ入れる時点で一度だけフィルタする）。`hiddenNames` は mount 中に固定する契約で、変えるときは呼び出し側が `key` を張り替える（root と同じ前提）
- **ブランチのチップは増やさない**。従来どおり「パネル root が属する repo」のもので、root の配下にあるネスト repo は列挙しない（`GET /api/files/git` は path 1 本で、親へ辿って 1 つの repo を答える）。ネスト repo を見たいときは 設定 → ファイル で確認する。ネスト repo まで出すなら repo の列挙から設計する別 Issue
- **隠した行には操作が届かない**ので、パネルから `.git` を削除 / ダウンロード / リネームする導線は無くなる（パネルは元々リネームを出さず、設定 → ファイル 側では従来どおり消せる）。行が減るぶん、`（空）` は「隠した行を除いた子が 0 件」、`上限のため N 件のみ表示しています` の N は隠した後の件数になる
- ファイル参照（本文のインラインコード）から `.git/...` を開く導線は残る。タブは開いて本文も出るが、ツリーに行が無いので reveal のハイライトは出ない

## ディレクトリの開閉

ディレクトリ行の開閉は、子の入れ物の高さを grid の行（`0fr` → `1fr`）で遷移させて見せる（`FileBrowser` の `.tree-fold`、遷移は `styles/index.css`）。`details` の折りたたみと違い開閉の状態は React が持つので、CSS は遷移だけを担う。子を `min-height: 0` / `overflow: hidden` で潰すため、`interpolate-size` に依存しない。

開閉の状態は `lib/fileTree.ts` の純関数が持ち、**閉じる操作は対象と配下の全子孫を閉じる**（`toggleFileTreeDirectory`）。開くときは対象だけを開くので、親を開き直しても以前の展開は戻らない。取得済みの一覧・`loading`・`error` は閉じても状態に残すため、開き直しで再取得は起きず、取得中に閉じても後着した一覧の応答で開きは復活しない。子孫の判定は区切りまで見るので、`a` を閉じても `ab` のような別パスは巻き込まない。

- 入れ物（`.tree-fold`）は開く前から置く。mount した要素には遷移の前の値が無いため、開いたときに初めて mount すると初回の開が瞬時になる
- **待ちの印の行と内容は別の入れ物にする**（`open && !loaded` / `open && loaded`）。同じ入れ物の中で入れ替えると、開き切った後の高さ（`1fr` の解決値）は変わっても遷移が走らず、一覧の到着が飛んで見える（実測: 取得を 850ms 遅らせると 30px → 158px が瞬時になる）。分けると、畳まれる待ちの行と伸びる内容の 2 つの遷移が同じ長さで重なる
- 閉じた枝も**取得済みの内容は DOM に残す**（内容の入れ物は開閉に関わらず描き、`children` があるときだけ `Branch` を入れる）。畳むときも同じ遷移で潰すため。取得は `pendingFileTreeDirectories` の経路のまま（閉じた枝からは取りに行かない）
- 閉じている入れ物は `inert` にする（`data-open` と同じ条件で、ディレクトリが開いていても閉じている入れ物は対象）。高さ 0 で見えない行をフォーカスさせず、支援技術からも外す（取得が終わった後の待ちの印が読み上げに残らない）
- `prefers-reduced-motion` では遷移させず瞬時に開閉する（`details` の折りたたみと同じ扱い）
- 高さの遷移の途中は行の位置が確定しないため、reveal はスクロールを遷移の後に合わせ直す。合図は `transitionend`（`grid-template-rows` の遷移だけ）にする: 遷移が走った枝にだけ listener が付くので、**祖先が既に開いているときは何も起きず**、直後の手動スクロールを巻き戻さない。`transitionend` は泡で届くため、**その入れ物自身の遷移だけ**を見る（`event.target === event.currentTarget`。兄弟の枝を開いても祖先の listener が鳴る）。遷移の長さを JS の定数に写すと CSS を変えたときに黙ってずれるため、待ち時間の定数は持たない（`prefers-reduced-motion` でも遷移が無く、最初のスクロールがそのまま正しい）
- 見え方は client に DOM テスト基盤が無いため自動では見ず、**手動確認**とする（テストは CSS の定義と配線と時間の一致だけを固定する）

## ツリーの reveal

ツリーでファイルの位置が分かるように、対象の祖先ディレクトリを開いて対象の行へスクロールし、しばらく一時ハイライトする（`FileBrowser`）。**画面の root は変えない**（サブツリーへ再ルートする機能は持たない）。表示するパスは常に画面 root 相対のままで、タブ・ドラッグ参照・confirm と同じ座標を使う。入口は 2 つで、どちらも同じ `revealRow` を通る。

- **ファイル参照からタブを開いたとき**（`openRequest` の適用時）。参照のファイルは深い階層にあることが多く、プレビューだけ開くとツリーのどこにあるか分からないため
- **プレビューのパンくずのクリック**。ソース表示のパス行はセグメントごとのボタンになり、押すとその階層をツリーで示す（表示中のファイル自身もボタン）

- 祖先を開くのは `lib/fileTree.ts` の `openFileTreeAncestors`（純関数）。取得済みの子・loading・error は保ち、未取得の祖先は `open` だけの状態を作る。取得は既存の `pendingFileTreeDirectories` の経路が親から順に拾うので、reveal 専用の取得経路は持たない
- スクロールは対象の行が現れてから行う（祖先の取得中は行が無い）。行は `reveal` の state と `revealRowRef` で受け、`tree` が進むたびに Effect を再実行して取りこぼさない。スクロール済みの `seq` は再実行で弾く
- 一時ハイライト（`ring-2 ring-focus ring-inset`）はスクロールのあと `REVEAL_HIGHLIGHT_MS`（1.6 秒）で消す。タイマーは掛け直しと unmount で掃除する
- reveal で開いた階層は通常の展開と同じく `filePreviewStore` の保存対象に入る（F5・面の往復で復帰する）。reveal の対象とハイライトは保存しない
- パンくずは画面 root 相対の祖先と表示中のファイルだけを並べる（画面 root 自体はツリーにその行が無く押せないうえ、各面のヘッダが同じパスを出す: チャット右パネルのヘッダ / 設定の caption / スキル面の root 行）。全体パスは `fetchPath` のまま `title` に残す。項目の組み立ては `fileTreeBreadcrumbs` の純関数

## メッセージからの導線（ファイル参照）

assistant 本文のインラインコードが指すファイルを、右パネル / sheet のタブとして開く。字面の判定と面の種別つきの解決は `client/src/lib/fileRef.ts` の純関数、要求の保持と面のモードは `client/src/lib/fileRefRequest.ts`、インラインコードの描画は `client/src/components/markdown/FileRefLink.tsx` が持つ。**設定 → スキルの本文（プレビュー）も同じ導線を持つ。** 解決の基準はセッションの作業フォルダではなく**スキルディレクトリ**で、`scripts/survey.sh <dir>` のように「パス + 引数」で書かれているときは先頭の 1 語だけをパスとして採る（引数込みの字面をクリックすると、そのファイルをファイルタブで開く。採否は `client/src/lib/fileSkills.ts` の `skillFileRefPath`）。組み込みスキル（仮想パスでファイルタブが無い）ではリンクにしない。 Markdown リンクの横取り・prompt 規約・ツール履歴（`write` / `edit` 行）からの導線は非ゴール（対応サブセットは変えない。描画側の契約は [markdown.md](markdown.md#インラインコードのファイル参照)）。

### 字面の判定（matcher）

インラインコードの字面だけを見て、次の順で評価する（前段で落ちたら後段は見ない）。存在確認はしない。

1. 全体で拒否: 空白（ASCII 空白と `\p{White_Space}`）・制御文字（`U+0000`–`U+0020` / `U+007F`）・バックスラッシュ・`//` で始まる authority 形式・scheme 付き（`^[A-Za-z][A-Za-z0-9+.-]*:`）
2. 末尾形状（正規化の前）: 末尾スラッシュと末尾ドットのセグメントはファイル扱いしない（先に `a.png/.` を `a.png` へ畳むと拒否理由が消えるためこの順）
3. 正規化: 重複スラッシュの圧縮と `./` セグメントの除去（`a//b.png` / `a/./b.png` → `a/b.png`）
4. `..` セグメントは畳まず拒否（親参照で cwd の外を開かせない）
5. 拡張子: 最終セグメントの最後のドット以降が ASCII 英数字だけで、数字だけではないこと。最終セグメントが dotfile（先頭ドット）なら拡張子として扱わない（親ディレクトリの `.u7agent` は見ない）
6. コードスパンだけの除外: ディレクトリ区切り（`/`）を持たない裸名は採用しない（`resolveFileRefTarget`。パスが付いていても実体の無い語をリンクにしないため）。判定は正規化前の元の字面で行い、`./index.html` は採用のまま

| 入力 | 判定 | 理由 |
| --- | --- | --- |
| `./index.html` / `./a/b.png` | 採用 | 最終セグメントにドット付き拡張子があり、区切りを持つ |
| `AGENTS.md` / `index.html` / `navigator.clipboard` / `feedback.md` | 不採用 | ディレクトリ区切りを持たない裸名（コードスパンだけの除外）。実体の無い語をリンク化しない |
| `a//b.png` / `a/./b.png` | 採用（`a/b.png`） | 同じファイルの別表記でタブを重複させない |
| `assets/` | 不採用 | 末尾スラッシュ（ディレクトリ） |
| `localStorage` | 不採用 | ドット付き拡張子が無い |
| `node --check script.js` | 不採用 | 空白・記号を含む（コマンド行） |
| `v1.2.3` | 不採用 | 拡張子が数字だけ |
| `https://example.com/a.html` / `file:///tmp/a.html` | 不採用 | scheme 付きは URL として扱う |
| `//host/a.png` | 不採用 | authority 形式（スラッシュ圧縮より前に拒否） |
| `foo.bar()` | 不採用 | 拡張子に `(` `)` などの記号が入る |
| `a` + `U+0000` + `.png` | 不採用 | 制御文字を含む |
| `foo(bar).png` | 採用 | 記号は拡張子の中だけ拒否する（パス本体の記号は許容） |
| `release..notes.md` | 採用 | `..` はセグメント全体が `..` のときだけ親参照 |
| `a/../b.html` | 不採用 | 親参照セグメントを含むものは一律拒否（安全側） |
| `.gitignore` / `.env.local` | 不採用 | 最終セグメントが dotfile |
| `x.` / `a.png/.` | 不採用 | 末尾ドットのセグメント（正規化前の末尾形状検査） |
| `a\b.png` | 不採用 | バックスラッシュは区切りとして扱わない |

`dist/config.prod` のような見た目のパスはリンクになり得る（見た目ではなく拡張子の形だけを見るため）。これは matcher の限界として受け入れる。同じ理由で、cwd 直下に実在する `AGENTS.md` もリンクにならない（[残る懸念](#残る懸念裸名の除外と存在確認)）。

### 解決（面の種別と座標）

`rootCwd` は `health.cwd`（ワークスペース root の絶対パス）、`cwd` は選択中セッションの `payload.cwd`。コードスパンの解決は `resolveFileRefTarget(raw, rootCwd, cwd)` が行い、`{ kind: "work", path }`（作業フォルダ面。`path` は cwd 相対）か `{ kind: "skill", root, path }`（スキル面。`root` はワークスペース root 相対、`path` はその root 相対）を返す。**Markdown 画像は `resolveFileRef` のまま**で、返すのは cwd 相対の文字列だけ（[markdown.md](markdown.md#画像の-src-解決)）。

作業フォルダ面を先に見て、次に絶対パスだけを共通スキルへ回す。判定はどちらも matcher の正規化後の座標で行う（`6.` の裸名の除外はその前）。

| 入力の形 | 扱い |
| --- | --- |
| `/workspace/...`（`rootCwd` 前置きの絶対パス） | `rootCwd` を剥がす。剥がせなければ不採用。剥がした結果が cwd 配下（`cwd + "/"` 境界）なら cwd 前置きも剥がして cwd 相対にする（`kind = "work"`）。cwd 配下でないときは次の行の判定へ進む |
| `/workspace/.agents/skills/<name>/<file>`（`rootCwd` 前置きの**共通スキル配下**） | `kind = "skill"`、`root = .agents/skills/<name>`、`path = <file>`。`<file>` は `SKILL.md` でも補助ファイル（`assets/a.png` など）でも同じ扱い |
| `.agents/skills/<name>/<file>`（ワークスペース root 相対の字面） | スキル面へは振り分けない。cwd 相対の `kind = "work"` として現行どおりリンク化する（プロジェクトスキルと衝突するため） |
| その他の絶対パス（`/etc/...`、`/workspace/generated/...`、`/workspace/projects/x/.agents/skills/...` など） | 不採用。`rootCwd` 未取得（health 未取得）のときも絶対パスは不採用 |
| `./x`（明示的な相対） | cwd 相対として扱う（`kind = "work"`）。**cwd 前置きの剥がしはしない**（`projects/u7agent/a.html` は `<cwd>/projects/u7agent/a.html` を意味するため） |
| `x`（区切りの無い裸名） | 不採用（`6.` のコードスパンだけの除外）。`matchFileRef` / `resolveFileRef` は採るため、Markdown 画像の src 解決は変わらない（[markdown.md](markdown.md#画像の-src-解決)） |
| `..` セグメントを含む | 不採用（matcher で除外） |

- スキル面へ回すのは**絶対パスだけ**。`.agents/skills` 直下（`<name>` が無い）と `<name>` だけ（ファイルが無い）の階層は不採用になる。`<name>` は最初のセグメント 1 つで、`alpha-2` を `alpha` へ混ぜない
- **絶対パスが cwd 配下でもある場合は作業フォルダ面を優先する**（プロジェクトの cwd が `.agents/skills` 配下にある場合など）。既存の採否は変えない
- 裸の `.u7agent/uploads/<id>/a.png` はこの規則どおり `<cwd>/.u7agent/uploads/<id>/a.png` を指す（予約 prefix の例外は持たない）。絶対パスの `/workspace/.u7agent/uploads/<id>/a.png` は cwd 外で、共通スキルでもないので不採用
- プレビューで `Path not found` のときは元のエラーを残し、**失敗したファイルが共通スキル配下（`.agents/skills/<name>/…`）のときだけ** 設定 → スキル からも開けることを案内する。作業フォルダ側の `<cwd>/AGENTS.md` など、面に関係のないパスには出さない（`client/src/lib/filePreviewError.ts` がプレビューの fetchPath で判定する。補助文の文言は `共通スキル配下のファイルは 設定 → スキル から開けます。` で変えない）
- セッションの cwd が未確定（未作成チャット）の間は**どちらの種別も解決しない**。設定 → ファイル はワークスペース root 固定なので対象外
- 保証は**字句的な包含だけ**。symlink の実体が cwd / 共通スキルの外を指す場合までは保証しない（サンドボックスの検証は既存契約のまま workspace root 内）。`health.cwd` が symlink のときは、サンドボックスが返す realpath と字面がずれてリンクにならないことがある

### クリックと要求

- クリックすると、**面の切替・要求の登録より前に**サンドボックスへ実在を確認する（`GET /api/files/stat`。[api-files.md](api-files.md#存在確認)）。開くのは通常ファイルとしての 200 だけで、404（不存在）・400（不正入力 / root 外 / 通常ファイル以外）・502 / 503 / 通信失敗では面を開かない。順序と分類は `client/src/lib/fileRefOpen.ts` の `createFileRefOpener` / `classifyFileRefFailure` が持ち、確認先は `fileRefCheckPath`（作業フォルダ面は `fileTreeFetchPath(cwd, path)`、スキル面は `<root>/<path>`）がワークスペース root 相対へ写す
- **クリック世代で後着の結果を捨てる**（A→B / A→B→A のどちらでも最後のクリックだけが開く）。確認中に選択中セッションが切り替わった結果も失効させる: 確認の開始時に**選択の切替世代**（`fileRefRequests` の `clear` の回数。`selectSession` / `newChat` の開始時と、`applySelectedSession` で ID が変わるときに進む）を控え、完了時に一致を要求する。ID の一致で見ると切替をまたいで同じ ID へ戻ったときに失効が巻き戻るため、世代で判定する（要求の `clear` は、まだ登録されていない確認には届かない）。不存在・拒否・確認不能と分かったときは要求を登録せず、**既に開いている面のモードとタブも変えない**
- 失敗理由はクリックした要素の近くに出す。`InlineFileRef` がクリック元の状態（確認中 / 失敗）を持ち、失敗時は参照の直後に `.md-fileref-note` の 1 行を添える（文言は不存在 `ファイルが見つかりません` / 拒否 `このパスは開けません` / 確認不能 `ファイルを確認できませんでした。もう一度お試しください`）。確認中は押した要素を `aria-busy` と薄い表示にし、**確認中の文字を足さない**（段落の折り返しが動いて押下位置から逃げないため）。読み上げは `ChatArea` の `aria-live` に任せ、専用の live region は足さない
- 操作要素にするのは assistant 本文のインラインコードだけ。`type="button"` で、Tab 移動 / Enter / Space / 可視 focus / 読み上げ名を持つ。**Markdown リンクの children の code は対象外**（`[`./index.html`](https://example.com)` は従来どおり `<a>` の中の code で、操作要素を入れない）。user 本文と、`MARKDOWN_MAX_LENGTH` 超のプレーン表示フォールバックも対象外
- クリックしたときの面は**解決先の種別**で決める。`kind = "work"` は作業フォルダ面、`kind = "skill"` はスキル面を開く。逆向きの参照（スキル面の表示中に作業フォルダの参照など）も面のモードを切り替えてから開き、消費されない要求を残さない。操作要素の `title` も種別に合わせる（作業フォルダは `作業フォルダで開く`、スキルは `スキルで開く`）
- 要求は `{ seq, sessionId, kind, root?, path }` として `useSessions` の store が 1 件だけ持つ。`kind` は `"work" | "skill"` で、`root` はスキル面だけが持つ（ワークスペース root 相対）。`seq` は App の存続期間で単調増加し再利用しない。消費前に複数クリックが届いたら最後の要求だけが残る（最新優先。中間クリックのタブ作成は保証しない）
- 要求の寿命は選択中セッションの滞在期間に限る。`selectSession` / `newChat` の開始時と、`applySelectedSession` で ID が変わるときに破棄する（A→B→A と戻っても復活しない。`cwd` はセッション識別子にならず、同一プロジェクトの別セッションでも選択が変われば破棄する）。**確認中の結果も同じ契機で失効させる**ため、破棄は `clear` の世代として数え、要求の有無に関わらず進める
- パネル / sheet は条件付き mount なので、`FileBrowser` が mount 後の Effect で未消費の要求を適用し、`onHandled(seq)` で App へ返す（`reloadToken` の「mount 時の値は無視する」方式は初回クリックを取り落とすため使わない）。App の ack は現在の pending の `seq` と照合し、古い ack で新しい要求を消さない
- **面は自分宛ての種別の要求だけを適用する**（`fileRefRequestForKind`）。作業フォルダ面はスキル要求を、スキル面は作業フォルダ要求を消費しない。モードを切り替えてから対応する面が受け取るため、相手側の面が動くのは 1 レンダーの間だけになる
- 適用の印は `FileBrowser` の ref が持ち、適用の直前に記録する。Effect の再実行（StrictMode）では二重に適用しない。`openFileTab` は同一パスでも新しい state を返すため、「タブが増えない」ことは 1 回適用の根拠にならない
- 復元は `useState` の初期化、要求は Effect で適用するため、要求が最後に効く（表示中のタブが要求のパスになる）。要求の適用時はツリーの祖先を開いて対象の行を示す（[ツリーの reveal](#ツリーの-reveal)）
- 表示モードは既存の選択規則のまま（未選択の HTML だけ既定でプレビュー。ユーザーがソースを選んだタブはソースのまま）
- singleColumn の sheet は閉じたときに、クリックした button を `App` が保持して focus を戻す（`document.activeElement` はクリックした button を指すとは限らない）。起点がセッション切替などで消えていたら focus を移さない。トグルから開いたときは `App` は起点を保持せず、sheet を表示したときの `document.activeElement` （通常は 📁 のトグル）へ戻す。戻り先は sheet が `showModal()` する前に 1 回だけ決める（Effect の再実行では 2 回目の `document.activeElement` が sheet の中の要素になる）。Escape は dialog の標準動作で閉じる（プレビューの中にフォーカスがあると親へ届かない既知制約は HTML プレビューと同じ）
- provider は `App` が `rootCwd` / `cwd` / callback だけの memo 値で配る。要求 `seq` やパネル開閉を value に混ぜず、SSE の更新で過去の本文を再解析・再描画させない。インラインコード側だけが context を購読するため、独自 comparator を持つ `MdBlockView` / `MdList` / `MdListItemView` / `MdTable` に callback を通す必要がない

### 面のモード（作業フォルダとスキル）

参照から開く面は `SessionFilesPanel` / `SessionFilesSheet` の 1 つのスロットに**モード**として載せる（面ごとの別ペインは追加しない）。モードは `{ kind: "work" } | { kind: "skill", root }`（`client/src/lib/fileRefRequest.ts`）で、App が要求の種別から決める。

| モード | 中身 | ヘッダ |
| --- | --- | --- |
| 作業フォルダ（既定） | タブ（作業フォルダ / 環境変数）+ root の操作行 + `FileBrowser` | 作業環境 + 閉じる |
| スキル | root の 1 行 + `FileBrowser`（`readOnly`） | スキル + 作業フォルダへ戻る + 閉じる |

- スキル面の `FileBrowser` は root = `.agents/skills/<name>`（ワークスペース root 相対）、`readOnly`、`excludeNames={[]}`、`reloadToken` = `ChatState.runEndSeq`（ヘッダの「再読み込み」は持たないので、run 終了だけが取り直しの入口）。**`hiddenNames` と `canRef` は渡さない**（`.git` も隠さず、スキルのパスは cwd 相対ではないため入力欄への参照にもしない）。`filePreviewPort` は既存の面と同じく health から受け取り、画像 / HTML プレビューを既存タブと同じ挙動にする
- 一覧（`GET /api/skills/files`）は**引かない**。root と path だけで開くため、作成直後のスキルや一覧に載らない配置（`SKILL.md` 以外）でも開ける（[api-catalog.md](api-catalog.md#ファイルスキルagentsskills)）
- root は mount 中に固定する（変更は `FileBrowser` の `key` による remount）。同じ root への再要求では remount せず、開いているタブとツリーを保つ
- 面の状態（表示中の skill root とタブ）は要求の pending と独立に持つ。ack で pending が消えても面は閉じない
- モードを既定（作業フォルダ）へ戻す契機: 閉じる導線（パネル / sheet の ✕、sheet の `Escape`、トップバーのトグルの閉）、**選択中セッションの変化**（セッション切替 / 新規チャット。`cwd` が同じでも戻す）、チャット以外への移動、singleColumn ⇄ desktop の切替。desktop のパネル開閉 state は既存どおり残るので、「面を閉じる」はモードを既定へ戻すことを指す（右パネルは開いたまま作業フォルダへ戻る）。作業フォルダ面（`SessionFilesPanel` / `SessionFilesSheet`）の root と開閉 state は書き換えず、モードと戻る導線で往復する
- 作業フォルダ面とスキル面は同時に mount しない（モードで出し分ける）。作業フォルダ面へ渡すのは `kind = "work"` の要求、スキル面へ渡すのは `kind = "skill"` の要求だけ（自分宛ての種別だけを適用する）
- `filePreviewStore` からの復帰はスキル面の root でも同じ契約で、設定 → スキルの同じ root とタブ状態を共有しうる（開き直しで新しいタブだけになることは保証しない）。singleColumn の sheet はクリックした button を `App` が保持して閉じたときに focus を戻す（既存契約のまま）

### 残る懸念（裸名の除外と存在確認）

- **裸名の除外でリンクが減る**: 対象プロジェクトを cwd にしているセッションでは、実在する `AGENTS.md` や `index.html` もリンクにならない（`./AGENTS.md` や `sub/AGENTS.md` のように区切りを付ければリンクになる）。cwd の一覧を取って裸名を再許可する案は採らない（裸名の除外はコードスパンの解決だけに閉じ、Markdown 画像の src 解決は変えない）
- **確認はクリック時点の実在**: 確認とプレビューの取得の間に外部で消えると、従来どおり `Path not found` のエラー帯が出る（再確認や面の自動クローズはしない）。逆に、cwd に同名の実体がある基準違いの参照（`./assets/…` が cwd にもある場合）は確認を通ってそのファイルを開く（文脈依存の推測解決はしない）
- **クリック 1 回につき往復が 1 回増える**: 描画時の一括確認はしない（大量の参照がある本文でサンドボックスを叩かない）。確認の API が失敗したときは、開かない代わりにクリックした場所へ確認不能の理由を出す

## ツリーの行のドラッグ（入力欄への参照）

デスクトップの右パネルのファイル行をチャットの入力欄へドロップすると、その行のパスが本文へ `@<作業フォルダ相対のパス>` として挿さる。**添付（アップロード）ではない**のでファイルは送られず、モデルが必要なときに `read` で開く（`@<path>` が cwd 相対の参照であることは `server/src/agent.ts` の `appendSystemPrompt` が説明する）。字面と区切りの規則は `client/src/lib/fileMention.ts` の純関数、ドロップの受け取りは `Composer` が持つ。

- ドラッグできるのは参照のパスが作業フォルダと一致する面だけ（`FileBrowser` の `canRef`。渡すのは desktop の作業フォルダ面）。設定 → ファイル はワークスペース root、スキル面（設定 → スキルのファイルタブ / チャットのスキル面）は SKILL.md の親ディレクトリで、パスの意味が違う。singleColumn の sheet は全画面 modal で入力欄へ届かない
- ディレクトリ行はドラッグできない（`@<dir>` はファイルとして `read` できない）
- 積む型は参照専用の `application/x-u7agent-file-mention`（パス）と `text/plain`（`@<パス>`）。入力欄はこの専用の型を `Files` より先に見て、参照を添付へ倒さない。`text/plain` があるため、他のアプリ / 入力欄へ落とすと参照の字面になる
- 挿入位置はドロップ座標（`caretPositionFromPoint`。`caretRangeFromPoint` は textarea で正しい位置を返さないブラウザーがある）、取れなければ現在の選択。前後が非空白なら区切りに空白を足し、カーソルは参照の直後（続きを書ける位置）へ置く
- 空白・二重引用符・バックスラッシュを含むパスは `@"<パス>"` と二重引用符で囲む（`"` と `\` はエスケープ）。区切りに足す空白と同じ字がパスに入っていると、送信時の `trim`（クライアントの `value.trim()` とサーバーの本文）で末尾の空白が消えて別のファイルを指すため
- 存在確認も展開もしない。消えているパスでも挿せて、区切りの解釈はモデルに委ねる（[メッセージからの導線](#メッセージからの導線ファイル参照) の matcher とは別の規則）
