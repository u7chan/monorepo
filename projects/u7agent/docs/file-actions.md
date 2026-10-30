# ファイルの行の操作

行の ⋯ メニュー（パスをコピー / 共有 / 削除 / リネーム / ダウンロード）と、サイズ・時刻の表示、画面を往復したときの復帰の契約。出し分けの正は `client/src/lib/fileRowMenu.ts`。ツリーの表示は [file-tree.md](file-tree.md)、プレビューの描画は [file-preview.md](file-preview.md) を参照する。

## パスをコピー

ツリーの行のパスをクリップボードへ取る導線。行の右端の ⋯（[行の操作メニュー](file-tree.md#行の操作メニュー)）の「パスをコピー」（その面の root からの相対）と「絶対パスをコピー」の 2 項目から、`client/src/lib/copyToClipboard.ts` でコピーする。

- **コピーする字面はその面の root からの相対パス**（ツリーの行・タブ・パンくずと同じ `path`）。チャット右パネル（作業フォルダ面）ではセッション cwd 相対になり、そのまま入力欄へ貼って `@` 参照に使える。設定 → ファイル（ワークスペース root）ではワークスペース root 相対なので、`@` 参照（cwd 相対）とは基準が違う
- **「絶対パスをコピー」はワークスペース root の絶対パス（`health.cwd`）を前置して組み立てる**（`client/src/lib/fileTree.ts` の `fileTreeAbsolutePath`）。チャット右パネルではセッション cwd が入るので `<health.cwd>/<セッション cwd>/<行のパス>` になる。**health 未取得（`""`）の間は字面を作れないため項目ごと出さない**（health は起動直後に届くので、行の ⋯ を開く時点では通常出ている）
- **相対と絶対の 2 本を並べる**のは、相対がその面の `@` 参照と表示に、絶対がターミナル / エディタ / エージェント指示への貼り付けに使えるため。どちらが `@` 参照に使えるかは相対側の 2 行目が示す
- **ファイル / ディレクトリ / symlink のすべての行に出す**（字面は種類に依らず取れる。ダウンロードや削除と違い、除外名の行にも出す）。**読み取り専用の面（スキル設定のファイルタブ / チャットのスキル面）も出す**（`readOnly` が落とすのはダウンロード以下の実体を移す / 変える項目だけ）。相対パスが skill dir 基準で `@` 参照には使えないため、**絶対パスをコピー**がスキル配下の受け皿になる（ワークスペース root の絶対パスを前置する既存の組み立て）
- **メニューの 2 行目は字面ではなく基準を開示する**（相対側の「ツリーの root からの相対パス」）。絶対側はラベルだけで基準が決まるので 2 行目を持たない。パスそのものは出さない（メニューは幅を内容に合わせるため、長いパスを出すと viewport の横へ伸びる。メニューの寸法は `MenuItem` の 1 箇所に置く契約で、ここに `max-width` を足さない）
- **成功したら ⋯ をチェック + `コピーしました` に 2 秒替える**（`useMessageCopy`。項目は選択で消えるため、結果は ⋯ の位置に出す）
- **失敗したら成功表示にせず、行の中に `role="alert"` の 1 行を出す**。文言と内訳は [コピー](file-preview.md#コピー) の `CopyButton` と同じもの（`useMessageCopy` の `copyFailure`）を使い、開発者ツールを開けない環境でも理由が読めるようにする。`選択` は、コピーする字面が行の上で選択状態にできないため付けない。同じ行のコピーをやり直すと消える
- 同じ行の再コピーは弾かない（冪等）。連続したコピーでは `useMessageCopy` の連番が古い結果だけを捨てる

## 共有

ディレクトリを Cloudflare へ外部公開する導線。ディレクトリ行の ⋯（[行の操作メニュー](file-tree.md#行の操作メニュー)）の「共有」から、共有ダイアログ（`client/src/components/ShareContentDialog.tsx`）を開く。

- **出す面はチャット右パネル（作業フォルダ面）だけ**。項目の採否は `fileRowActions` の `canShare` で、`FileBrowser` に渡すのは作業フォルダ面だけ（共有 API の `directory` がセッションの作業フォルダ相対のため）。**設定 → ファイルには出さない**。会話が決まっていない面（プロジェクト起点の新規会話）・スキル面・読み取り専用の面と、symlink の行には出さない。ファイルの行にも出さない（`index.html` の例外を除く）
- **例外はツリーの root 直下の `index.html` 行の「このフォルダを共有」**（ファイル行なのに同じフォルダ全体が上がるため、2 行目で開示する）。対象は作業フォルダ自身（`directory` は root 直下の行の `parent` = `.`）で、サブディレクトリの `index.html` 行には出さない（そのディレクトリ行の「共有」で足りる）。出し分けは `canShareSessionRoot` で、非プロジェクト会話（`SessionSummary.projectSession` が明示的な false）のときだけ true になる。ディレクトリ行の「共有」は `canShare` だけで決まり、セッション種別では絞らない
- メニューの 2 行目は `serve`（一時プレビュー）との違いを開示する（押す前に知る条件なので `singleColumn` でも残す）
- ダイアログの流れ・確認項目・ポーリング・既知の制限は [static-sharing.md](static-sharing.md#gui共有ダイアログ) を正とする

## 削除

誤ってアップロードしたファイルやエージェントの成果物を取り消す導線。通常ファイルとディレクトリの行の右端の ⋯（[行の操作メニュー](file-tree.md#行の操作メニュー)）の「削除」から、共通の確認ダイアログ（`fileTreeDeleteConfirmRequest`。セッション / プロジェクト / エージェント削除と同じ）で確認してから `DELETE /api/files` を呼ぶ。

- **出す画面は設定 → ファイル（ワークスペース root）とチャット右パネル（セッションの作業フォルダ）の 2 つ**。`FileBrowser` に画面を分ける `canDelete` は持たせず（`onDelete` も必須にする）、通常ファイルとディレクトリの行の ⋯ には常に「削除」を出す。プロジェクトのソースを GUI から消せる点は「ワークスペース全体を見ながら片付けたい」という要望を優先して受け入れ、事故防止は confirm のパス表記が担う。**dev の root は `PI_APP_CWD`（既定は `projects/u7agent` 自身）なので、自分のソースも消せる**
- **スキル設定のファイルタブ（読み取り専用の面）は `readOnly` を渡し、ダウンロード / 削除 / リネームを出さない（⋯ にはパスのコピーだけが残る）**（補助ファイルの持ち出しはスキルのエクスポート `GET /api/skills/files/export` が担い、削除 / リネームは従来どおり「ファイル」画面の行から行う）。既定は false なので、上の 2 画面の挙動は変わらない
- **confirm にはその画面の root 相対（ツリーに見えているパス）を出す**。ファイルは `client/src/lib/fileTree.ts` の `fileTreeDeleteConfirm(path)`（`「<path>」を削除しますか？この操作は取り消せません。`）で、設定 → ファイル は `.u7agent/uploads/3a7bfba36f/shot.png`、チャット右パネルは作業ディレクトリ相対（`node/main.ts` など）になる。ディレクトリは `fileTreeDeleteDirectoryConfirm(path)` で、配下ごと消えることを示す `「<path>」と配下のファイルをすべて削除しますか？この操作は取り消せません。` を出す。パネルでワークスペース root 相対（見えていない長いパス）を出すと行との対応が取れないため、見えているパスに合わせる（ワークスペース root を見る設定 → ファイル では両者が一致する）
- **通常ファイルは 1 件、ディレクトリは配下ごと消える**（`recursive=true`。空ディレクトリも同じ導線）。削除範囲は一覧の上限（500 件 / ディレクトリ）に縛られず、未表示の子も消える。**symlink は行に導線を出さない**（サンドボックスが 400 で拒否する。ファイル / ディレクトリとも。symlink の行には既存の「リンク」バッジが付く）。`.u7agent/uploads/<id>/` はフラットだが、セッション作業フォルダの `uploads/` などの片付けにディレクトリ削除を使える
- **削除したディレクトリ配下の symlink はリンクだけが消え、リンク先は残る**（`rm -rf` と同じ）。削除対象そのものが symlink なら 400 で、リンクもリンク先も残る
- 行は選択（本文を開く）と ⋯ の 2 つの `button` に分ける（`button` の入れ子は作れない）。⋯ は常時見せ、hover で隠さない（タッチ端末で押せなくなるため）。削除は ⋯ の中へ移り、1 行あたりのタブストップは ⋯ の 1 つに縮む（移行前は最大 3）
- 成功したらその行を一覧から落とし（`removeFileTreeEntry`）、開いていたタブを閉じる。ディレクトリは配下の state も `pruneFileTreeSubtree` で落とし、配下のタブを `closeFileTabsUnder` で閉じる（表示中のタブが消えたときの繰り上がりは `closeFileTab` と同じで、右の生存タブ → 右なしで左 → 全消去）。**自分で消したものだけ**閉じる（外部で消えたファイルのタブは本文の取得エラーを出して残す現行挙動のまま）
- 失敗したら親ディレクトリのエラーとして出し、行は残す（`applyFileTreeError`。他のディレクトリの表示は維持し、「再読み込み」で消える）
- 未送信の添付チップが指すファイルを消しても、送信自体は通る（注記は保存先のパスを載せるだけ）がサムネイルは 404 になる。今回は許容する（チップ側からも消せるようにするなら別途）
- 同じ行の二重送信は実行中のパスを持つ ref で弾く。エージェント実行中・プレビュー取得中との直列化は持たない（既存の同時操作と同じ）

### 既知の制限（削除）

- **pending 一覧の復活**: 削除直前に飛んでいた親一覧の応答が後から適用されると、削除済みの行が復活し得る（`FileBrowser.tsx` の適用は無条件）。クリックすると 404 になり、次の取得（「再読み込み」/ run 終了）で消える。取得世代での無効化は別 Issue。復活した行を利用者が再操作した場合も、保存値からの除去は保証しない（削除成功時の反映は自画面の state が対象）
- **競合（TOCTOU）**: サンドボックスの入力検証（root 外 / symlink / 形式）は「競合がない場合」の契約で、親 realpath の後に祖先が rename + symlink へ差し替えられると root 外を消し得る（[sandbox-api.md](sandbox-api.md#delete-v1dirs)）。fd 相対の削除が Node に無いため完全な防御は入れない
- 大きいツリーは応答まで時間がかかる（行は応答まで残る）。`fs.rm` が途中で失敗すると部分削除が残り、親にエラー表示が出る（「再読み込み」で実際の状態に戻る）
- 並行削除: `lstat` 前の不存在は 404、検証後の `ENOENT` は成功。同一パスの二重送信は `deletingRef` が弾くが、親子の同時削除は直列化しない（後から来た要求は 404 か成功になる）

## リネーム

名前を直したいフォルダを削除して作り直さずに済むよう、設定 → ファイル のフォルダ行にリネームの導線を出す。行の右端の ⋯（[行の操作メニュー](file-tree.md#行の操作メニュー)）の「名前を変更」から、削除と同じ流れの入力ダイアログ（`fileTreeRenameRequest`）で新しい名前を入力し、`POST /api/files/rename` を呼ぶ。

- **出すのは設定 → ファイル（ワークスペース root）だけ**。`FileBrowser` の `canRename` prop（既定 false）で切り、`FileTreePage` だけが true を渡す。チャット右パネル（`SessionFilesPanel`）は対話中のパスと食い違うため出さない。スキル設定のファイルタブは `readOnly` で削除と一緒に消す（`canRename` も渡さない）
- **リネームを出すのはフォルダ行だけ**。UI からファイルは改名できない（API はファイル / ディレクトリの両方を受ける。移動（親ディレクトリの変更）は非ゴール）。symlink の行にも出さない（サンドボックスが 400 で拒否する）
- **prompt の初期値は現在の名前**（`fileTreeRenameRequest(path, currentName)` が対象のパスを clamp した行と初期値を組み立てる）。取り消し・空・未変更なら何もしない（`renameInputValue`）。削除の確認と同じく、同じ行の二重送信は実行中のパスを持つ ref で弾く（ダイアログを開く前に立てる）。run 中でも操作できる（削除と同じでガードなし）
- **成功後はツリーとタブ・表示モードの経路を新しい名前へ張り替える**。親一覧の行の名前を差し替え（`renameFileTreeEntry`）、配下の state のキー（`renameFileTabs` / `renamePreviewModes`）を移す。開いている階層と取得済みの子はそのままなので親の再取得は起きず、タブの本文だけを新しい経路で取り直す（プレビューの `results` は経路ごとなので、新キーで再取得する）。**取得中だった一覧は `loading` を落として新しい経路で取り直す**（飛んでいた応答は旧キーへ着地するため、持ち越すと改名したフォルダが待ちの印のまま固定される）。画面の root 相対は親 + 新しい名前で組み立てる（応答の実パスは symlink 経由の要求でツリーのキーとずれるため）
- **失敗は親ディレクトリの行に理由を出す**（`applyFileTreeError`。削除と同じ。同名 409 の文言をそのまま出す）。行はそのまま残る
- 改名先が既存の名前なら 409 で何も変えない（上書きも自動採番もしない）。大文字小文字だけの変更は許す（[sandbox-api.md](sandbox-api.md#post-v1filesrename)）
- リネームで登録プロジェクトの root や `.u7agent/sessions/<id>` を改名すると、プロジェクト / セッションの `payload.cwd` は追随しない（削除でも同じ。保護パスは設けない）

### 既知の制限（リネーム）

- **pending 一覧の復活**: 削除と同じ。改名直前に飛んでいた旧名の親一覧の応答が後から適用されると、旧名の行が復活し得る（クリックすると 404 になり、次の取得で消える）
- **同名の競合（TOCTOU）**: サンドボックスの同名判定は `lstat` → `rename(2)` の順なので、その間に同じ名前が作られると上書きされうる（Node に no-replace の rename が無い。単一ユーザーでエージェントと同時に触った場合のみ。[sandbox-api.md](sandbox-api.md#post-v1filesrename)）
- リネーム先が既存タブと同じ経路になったとき（外部で消えたファイルのタブが残っている等）は、重複したタブを作らず先のタブへ寄せる

## ダウンロード

ワークスペースからファイル / フォルダを持ち出す導線。ツリーの行の右端の ⋯（[行の操作メニュー](file-tree.md#行の操作メニュー)）のダウンロード項目から、**事前チェック（`GET /api/files/download/check`）を通してから**保存を始める。通常ファイルは生バイトのまま、フォルダは ZIP になる。

- **出す画面は設定 → ファイル（ワークスペース root）とチャット右パネル（セッションの作業フォルダ）の 2 つ**。行の右端は サイズ + 時刻 + ⋯ で、メニューの項目が パスをコピー → 絶対パスをコピー → ダウンロード → リネーム → 削除 の順になる。ダウンロードは通常ファイルとフォルダの行に出る。**スキル設定のファイルタブは `readOnly` でダウンロードを消し、⋯ にはパスのコピーだけを残す**（組み込みスキルはワークスペース外でサンドボックスから解決できないため、削除 / リネームと同じ扱い）。スキル（`.agents/skills`）全体のエクスポートはこの節の行の導線ではなく、スキルのエクスポート（`GET /api/skills/files/export`）が担う（[api-catalog.md](api-catalog.md#ファイルスキルagentsskills)）
- **symlink の行には出さない**（サンドボックスが 400 で拒否する。削除と同じ判定）。**除外規則に一致する名前の行にも出さない**（`node_modules` など。出すと押した直後に 400 になるため）。どちらの行も ⋯ と他の項目は残る
- **除外名は 設定 → ファイル の「ダウンロードの除外」タブ（`/settings/files/archive`。旧 `/settings/archive` は読み替え）で編集する**。一覧はアプリデータの SQLite に保存し、未設定のときは既定の一覧（`DEFAULT_ARCHIVE_EXCLUDE_NAMES`）、保存するとその一覧が正になる（`[]` は「除外なし」。空にすると `node_modules` も入るため画面が既定で畳んだ注意書きで警告し、展開で全文を出す）。規則はベース名の完全一致・全階層で、symlink は一覧に関係なく常に対象外（[api-files.md](api-files.md#アーカイブの除外名)、[persistence.md](persistence.md#アプリデータsqlite)）。ツールバーの [再読み込み] はこのタブに常設し、未保存の変更がある間だけ無効にする。理由は広い幅では帯の左、狭い幅ではヘッダに出す（帯は操作で埋まり、理由が 1 文字幅まで潰れるため。[ui-layout.md](ui-layout.md)）
- **共有（Cloudflare への公開）の除外は別の一覧**で、こちらとは保存行も既定値も違う（`dist` / `build` / `out` を既定で落とすかどうかが逆になる）。設定 → 共有の「公開の除外」（`/settings/sharing/exclusions`）で編集し、相互のタブへ文言の導線を置く（[static-sharing.md](static-sharing.md#公開の除外)）
- **除外名は設定ストアの実効値（`GET /api/settings/archive` の `excludeNames`）を `App` から prop で受ける**（`app.archiveSettings.settings?.excludeNames ?? []`）。取得元を health から app 状態へ移したのは、設定の保存直後に再 mount なしで 設定 → ファイル とチャット右パネルの両方が追随するため。未取得の間は空（= 除外なし）として導線を出し、実際の判定はサーバーの `check` に任せる（ずれた瞬間は `check` が 400 を返し、ツリーのエラー行に出る）
- **クリックで先に `check` を呼び、結果で振り分ける**。`kind: "archive"` で `skipped` が 1 件以上あるときだけ共通の確認ダイアログを 1 回出し、**サイズ / 件数の超過（413）・除外名のディレクトリそのもの（400）は確認より先にエラー行へ出す**（ダウンロードは始まらない）。確認は `client/src/lib/archive.ts` の `archiveConfirmRequest` で、対象のフォルダ名（clamp した行）+ `含まれるファイル数 N 件 / 合計サイズ X` + `除外: node_modules, dist`（**実際に落ちた名前をサーバーの `skipped` からそのまま出す**）を出し、ボタンは「ダウンロードする」にする。除外 0 件のフォルダと通常ファイルは確認なしで始まる
- **開始は `<a download>` のプログラム的クリック**（`startArchiveDownload`）。本文を `fetch` して state に保持しないため 100 MiB をメモリに載せず、ページ遷移も起きない（チャットのタブ・ツリーの開閉・実行中のランはそのまま）。`href` は `fileDownloadUrl` の URL、`download` 属性は `check.name`（サーバーの `Content-Disposition` と同じ名前。日本語名も化けない）
- **失敗（400 / 404 / 413 / 502 / 503）は削除 / リネームと同じく親ディレクトリの行に出す**（`applyFileTreeError`。生 JSON をブラウザに開かせない）。行はそのまま残り、「再読み込み」で消える
- メニュー項目はフォルダが「ZIP でダウンロード」+ 2 行目「ビルド成果物と依存を除く」、ファイルが「ダウンロード」で、⋯ の読み上げ名は `<名前> の操作`（除外の開示は確認ダイアログとメニューの 2 行目だけ。正確な規則は [sandbox-api.md](sandbox-api.md#get-v1filesdownload)）
- 同じ行の二重送信は実行中のパスを持つ ref（`downloadingRef`）で弾く。ダウンロード中も他の行は操作でき、ツリーの再取得やラン終了も止めない
- **上限は合計 100 MiB / 10,000 エントリ**（サンドボックスの定数）。単体ファイルも同じ 100 MiB で、メッセージは 1 本（`Download is too large (max … bytes)`）。上限は本文の送出前に判定するため、超過は「切れた zip」ではなく 413 になる
- **ZIP の中身はフォルダ直下をルートに置く**（フォルダ自身は前置せず、ダウンロード名 `<フォルダ名>.zip` が担う）。空ディレクトリは末尾 `/` のエントリとして残り、展開後に空フォルダとして復元される（**空のフォルダ自体を配ると中身が無いので空の zip になる**）。symlink は辿らず、エントリにも入らない
- 保存名・`Content-Type`・長さはサンドボックスが決め、BFF はストリームとヘッダを中継する（[api-files.md](api-files.md#ダウンロード)）。zip は長さを確定できないため `Content-Length` を付けない（ブラウザは保存表示で進捗を出す）

### 既知の制限（ダウンロード）

- **途中失敗は切れた zip になる**: 事前 walk の後にファイルが消えた / 読めなくなった / 接続が切れた場合、ブラウザは失敗として扱うが部分ファイルが残り得る（事前 walk で大半は防げる）。レジューム（`Accept-Ranges`）と進捗 UI は持たない
- **事前 walk と圧縮の間の増減で見積りがずれる**: 増えても実害はサイズだけで、減るとエントリが黙って落ちる（上限は近似になる）
- **クライアントが握る除外名（設定ストアの実効値）と実効値がずれる瞬間がある**: その場合は `check` が拒否し、ツリーのエラー行に出る（導線が出ないより先に整合する）
- **除外の拡大で「忠実なコピーではない」性質が強い**: 何が入らないかを開示するのは確認ダイアログとメニューの 2 行目だけで、正確な規則は [sandbox-api.md](sandbox-api.md#get-v1filesdownload) の記述を正とする
- ⋯ に畳むと削除が 1 クリック増え、深い階層では indent（16px × 深さ）の分だけメニュー化後も名前が数十 px しか戻らない階層が残る。同時ダウンロードの制限は持たない（単一ユーザー前提。zip 1 本あたりは 1 リクエスト）
- Zip64（4 GiB 超 / 65,535 エントリ超）は書かない。上限で回避する（緩和は別）

## サイズ

ファイル行の右端に、更新時刻の左へサイズ（`FileEntry.size`、バイト）を出す。描画は `client/src/components/FileBrowser.tsx` の `EntrySize` が行い、`size` の無い行では何も出さない。

- 値はサンドボックスの一覧が返す `size` をそのまま使う（`server/src/sandbox/service.ts` の `listWorkspaceDirectory`）。付くのは**通常ファイルとファイルへの symlink**（リンク先の実体サイズ）だけで、**ディレクトリには付かず、壊れた symlink も `undefined` になる**（ディレクトリの `size` はファイルの内容量を表さない。`type` が実体の種別になる既存契約と同じで、symlink の行にはリンク先のサイズが出る）
- 表記は `client/src/lib/attachments.ts` の `formatBytes`（添付チップ・アーカイブの確認・画像プレビューのメタと共通。`0 B` / `1023 B` / `1.0 KB` / `99.9 MB`）。`title` には `toLocaleString` した正確なバイト数（例: `1.0 KB` → `1,024 バイト`）を出し、時刻が `title` で完全表記を出すのと同じ形にする。数字の幅で行ごとにガタつかないよう `tabular-nums` を付ける。`formatBytes` が不正な値で返す空文字は行ごと出さない（`0 B` は表記する）
- **置き場所は時刻の左**（`名前 … サイズ 時刻 ⋯`）。時刻は従来どおり ⋯ の隣に残るため、時刻の右端のそろい方は変わらない。サイズと時刻は同じ `RowTail` に載せ、折り返しと間隔（下の [時刻](#時刻)）は共通で掛かる
- 一覧は追加の更新を持たないため、**サイズも時刻と同じく「再読み込み」と run 終了でしか更新されない**（画像プレビューのメタがツリーの行から引く `size` と同じ値。[画像プレビュー](file-preview.md#画像プレビュー)）
- **ディレクトリの配下合計サイズは出さない**（再帰 walk とキャッシュが要る）。サイズでのソート / フィルタも持たない

## 時刻

ディレクトリ行 / ファイル行の右端に更新時刻（`FileEntry.mtime`、epoch ms）を出す。`mtime` を持つ行だけに出すので、stat できない壊れた symlink の行には出ない。

- テキストはファイル行専用の `fileTimeLabel`（`client/src/lib/messageTime.ts`。今日 → `08:53` / 今年 → `9/21 08:53` / それ以前 → `2026/9/21 08:53`）。メッセージの `messageTimeLabel` は今年の分を `9/21` と日付だけで出すが、一覧では更新の前後を比べたいので月日を出すときも時刻を添える（今日 / 今年 / それ以前の分岐は両者で `timeScope` を共有する）。`title` に `messageFullTimeLabel`（`2026/9/21(日) 08:53`）を出す。`<time dateTime={new Date(mtime).toISOString()} title={…}>` の形の前例はチャットの吹き出し（`MessageView.tsx`）。数字の幅で行ごとにガタつかないよう `tabular-nums` を付ける
- 時刻とサイズを添えた分だけ名前の幅が減る。**コンテナ幅が `@2xs`（288px）未満では、サイズ・時刻・末尾スロットを入れた `RowTail` を `basis-full` で次の段へ落とし、行を 2 段にする**（`@2xs:basis-auto` で 1 段に戻る）。右パネルの下限は `min(360px, 30vw)`（未指定のときの幅。幅はハンドルで選べる。[ui-layout.md](ui-layout.md#モードごとの構成)）なので desktop の最小幅 720px では 216px になり、ここで 1 段に押し込むと名前の幅が先に尽きる。名前の幅が 0 になっても flex は行のアイコン（ディレクトリは chevron 16 + folder 16 + gap 8 = 40px）を縮められないため、1 段のままだとアイコンが時刻の上へはみ出す（実測: 幅 216px・`2025/9/5 23:05` の行でファイルアイコンが時刻に 9.92px 重なり、名前の幅は 0px）。2 段にすると名前は行幅いっぱいを使え（実測: 幅 216px で `node_modules` 87.17px・`package.json` 79.02px）、行高は 30px から 52px になる
- **2 段目は行幅いっぱいを使う**。インデント（`pl-(--tree-indent)`）は名前の行（`button`）が持ち、`RowTail` は行の左端から右端までを使える。これが無いと、深い階層 + 長いサイズ + 古い日付（例: 幅 216px・深さ 1・`100.0 MB`・`2025/10/30 23:05`）でメタの `min-content`（約 157px）が行の内容幅（約 118px）を超え、`tree-fold` の `overflow: hidden` が時刻の末尾と ⋯ を切って操作できなくなる（実測: 全幅化後はメタ約 157px 対 利用可能約 166px で 2 段のまま収まる）
- **1 段表示でも名前側の最小幅を確保する**。名前の `button` は行の `--name-min-width` で `min-width: min(calc(var(--tree-indent) + 48px), 100%)` を持ち（ディレクトリ行は chevron 16 + gap 8 + folder 16 + gap 8 の分を足した `+ 72px`）、名前へ 24px を割り当てられない行は `RowTail` を次の段へ落とす。symlink の行はリンク印（実測 33.45px）と gap 8px を足した `+ 90px`（ディレクトリ行は `+ 114px`）にする。`100%`（行の内容幅）で頭打ちにするのは、2 段表示の深い階層で最小幅が行からはみ出し、`tree-fold` の `overflow: hidden` に切られるのを防ぐため。これが無いと、狭い 1 段表示 + 深い階層 + 長いサイズ（実測: コンテナ 294px・深さ 3・`100.0 MB`・`2025/10/30 23:05`）で `button` が 81px（インデント 80px）まで縮み、`shrink-0` のアイコンがサイズの先頭へ約 9px 重なり、名前の幅が 0px になる（サイズの追加前はメタが短く、名前 24.53px が残っていた）。リンク印も同様に、コンテナ 342px・深さ 3 の symlink 行で印がサイズの先頭へ約 11px 重なっていた
- **それでも収まらないときは `RowTail` 自身が折り返す**（`flex-wrap` + `gap-y-1`）。サイズが `1023.9 KB` のように長く日付も長い場合は 2 段目に収まらず、メタが 3 段目へ折り返す。**⋯ を切らないことを優先し、行は 3 段以上になり得る**（メタの各項目は `shrink-0` のままで、切り詰めない）
- **ディレクトリ行もファイル行と同じ「div + 操作 button」の形にする**（以前は行全体が 1 つの `button`）。時刻を `button` の中に入れると accessible name に時刻が混ざり、時刻のクリックでも開閉してしまうため。`button` は `flex-1` のままで、インデントも `button` 側が持つ（上の「2 段目は行幅いっぱいを使う」のため）。クリック領域はインデントの手前（行の左端）まで広がるが、時刻・サイズ・⋯ は `button` の外なので accessible name には混ざらない
- 時刻の右端をそろえるため、両行の右 padding を `pr-2` にそろえ、行の末尾に `size-6` の ⋯ のスロットを 1 つ置く（行の右端は共通の `EntryRowActions`、その入れ物は `RowTail`）。時刻とスロットが接して見えないよう、行の `gap-x-1.5`（`RowTail` の折り返しは `gap-y-1`）を名前 / サイズ / 時刻 / スロットの間隔にし、一覧の左右の余白は `px-4`（行全体の外側）で持つ。⋯ は常時表示なので、設定 → ファイル は移行前に比べて名前へ 60px（`size-6` + `gap-x-1.5` の 2 スロット分）広がる。px の一致は client に DOM テスト基盤が無いため自動では固定せず、**手動確認**とする。操作の採否と公開属性は `client/test/fileRowMenu.test.ts`、幅と配置は [GUI 受入](testing.md#gui-の最小受入) で確認する。
- 意味は「更新」。サンドボックスが返せるのは mtime で、`birthtime` は overlayfs 等で 0 になり得るため使わない（アップロード / エージェントの書き出しでは実質の作成時刻と一致する）
- **サンドボックスの一覧はディレクトリにも `mtime` を付ける**（`size` はファイルだけ。ディレクトリの `size` はファイルの内容量を表さない）。規則は symlink は辿った先（`stat`）、それ以外は `lstat` を全エントリに適用し、`classifyEntry` が種別判定に使った `stat` は捨てずに再利用する（増える syscall は素のディレクトリの `lstat` 1 回）。ディレクトリ symlink にはリンク先の mtime が付く（一覧が実体で表す既存契約と一致）
- 一覧は追加の更新を持たないので、**行の時刻は「再読み込み」と run 終了でしか更新されない**。削除しても親ディレクトリ行の `mtime` は次の取得まで古いまま

## 復帰（F5・画面の往復）

ファイル画面は、F5 や チャット ⇄ 設定 の往復、パネルの閉じ開き、セッションの切替でも直前の状態に戻る（`client/src/lib/filePreviewState.ts`）。復帰は `FileBrowser` の mount ごとに 1 回で、root が変わるたび（設定を離れて戻る / パネルを開き直す / セッションを切り替える / スキルのファイルタブやチャットのスキル面を開き直す）に再適用し、通常の render やツリーの再取得・「再読み込み」では適用しない。保存は root ごとに分かれ、設定 → ファイル は常に `"."`（ワークスペース root 固定）、作業フォルダ面は `payload.cwd`、スキル面（設定 → スキルのファイルタブ / チャットのスキル面）は SKILL.md の親ディレクトリ（`.agents/skills/<name>`）を使うので、同じファイルを別の面で開いてもタブは混ざらない。保存値に残った他 root はそのまま残す（掃除はしない）。

- 復帰するのは タブの並び / 表示中のタブ / タブごとの表示モード / 開いているディレクトリ。配信元の選択は**保存しない**（F5 とタブを閉じるで既定の ON に戻る）。本文・children・loading・error は保存しない（他キーや複数 cwd と合算した容量と、鮮度の問題）。復帰後に本文を取得し直すため、表示中のタブ以外は選択したときに取得する（HTML は `/api/files/html/<path>`、ソースは `/api/files/preview`）
- 保存するのは開いているディレクトリ。閉じた枝の子孫は閉じているため保存に含まれず、復元して親を開き直しても子孫は閉じたままになる。root は常に開く。取得は既存の「可視の親から子へ」の経路のまま
- 復元は祖先がすべて保存集合にあるパスだけを開いた状態にし、そろっていないパスは落とす（閉じた枝の子孫が残った旧保存値を正規化する。祖先を勝手に開かない）。判定は集合で行うため、保存配列の順序には依存しない
- 消えていたファイルのタブは残し、本文の取得エラーをそのまま出す（勝手に閉じない）。削除済みディレクトリの枝は一覧の取得で落ちる。listing が `truncated` のとき未掲載の枝も落ちるため、完全な復元は保証しない
- 「再読み込み」はタブ・表示モード・展開を保ったまま本文だけを取り直す。最後のタブを閉じた状態（保存する内容が無い）は cwd ごと消すので、F5 後も空のままになる
- 保存値が壊れている / 形が合わない cwd は捨てる（他の cwd は残す）。9 枚のタブを持つ保存値も捨てる。これは通常操作の 9 枚目で最古を落とす `FILE_TAB_LIMIT` とは別の契約
- 保存領域が使えない環境（SecurityError / quota 超過）では、write が失敗した cwd をメモリ snapshot として持ち、同一セッション内の往復は復元できる。F5 を跨ぐ復元は保証しない（古い保存値が戻り得る）。保存キーと上限の全体は [frontend.md](frontend.md#保存キーと保存範囲)。**チャットのスキル面も root ごとの保存枠を 1 つ消費する**（`FILE_SNAPSHOT_CWD_LIMIT` 件を超えて開くと、先に書かれた root から落ちる）

## テスト

方針と実ブラウザでの確認は [testing.md](testing.md)。具体的な CSS・component の配線名は固定しない。

| テスト | 固定すること |
| --- | --- |
| `client/test/fileCode.test.ts` | 拡張子の言語判定 / 正規化・行数・コピー本文 / 上限での fallback / HTML・Markdown の判定 / 例外を投げない |
| `client/test/filePreviewSafety.test.ts` | ソース本文の HTML 挿入・HTML パース・インライン style の禁止（限定的なソース走査） |
| `client/test/fileTabs.test.ts` | 表示モードの既定（HTML と Markdown と画像と音声だけプレビュー）/ 表示モードと配信元の選択の保持と破棄（配信元の既定は別オリジン = ストレージ有効）/ タブの開閉と上限 / ディレクトリ配下のタブの一括削除（接頭辞境界と繰り上がり）/ リネームの経路の張り替え（並び・表示中の保持、配下、重複の排除、表示モードと配信元）/ 保存値からの復元（表示中の繰り上がりと上限） |
| `client/test/toggleSwitch.test.ts` | 名前付きの role=switch / aria-checked / disabled / 実 handler の状態反転 |
| `client/test/filePreviewStorageMode.test.ts` | HTML の sandbox・配信元・切替の公開状態とポート未取得時の隔離 / srcdoc・blob・data 文書の禁止 / 別タブの noopener と操作名 / 画像の raw URL・メタ・HTML 用操作の非表示 / 音声の `<audio controls>`・raw URL・本文を取得しないこと（SSR） |
| `client/test/filePreviewMarkdown.test.ts` | Markdown のタブの既定（プレビュー）とソース / プレビューの公開状態 / 他拡張子に切替を出さないこと / HTML 用の操作を出さないこと / 描画した本文と dir 基準の画像 URL / 解決できない src の扱い（SSR） |
| `client/test/markdownAsset.test.ts` | 相対 src の解決（dir 基準 / `.` と空セグメントの畳み方 / `..` の往復と root 外の拒否 / 先頭 `/` / `?`・`#` の除去 / 前後の空白）と、外部 URL・fragment だけの不採用 |
| `client/test/imageRefresh.test.ts` | 実フックの同一 mount での再描画安定性・run 終了・手動更新 / 実 Markdown と FileBrowser → FilePreview の描画を通した面間・再 mount の URL 非衝突（SSR） |
| `client/test/imageMeta.test.ts` | 画像メタの表記（寸法とサイズの両方 / 片方だけ / どちらも無ければ null / 不正値の落とし方と 0 B） |
| `client/test/filePreviewTabClose.test.ts` | 中クリックの button 判定。タブの ×・中クリックの実操作はブラウザで確認 |
| `client/test/loadingMark.test.ts` | 待ちの印の公開状態（`role="status"` / スピナーは `aria-hidden` / 文字は `sr-only` の 1 箇所）と、本文待ち（ソース / Markdown プレビュー）とツリーの一覧待ちで出ること、本文を取得しない面（画像 / 音声 / HTML のプレビュー）では出ず、HTML のソース表示では出ること（SSR） |
| `client/test/fileTree.test.ts` | 開閉・子のマージ・エラー保持 / 親を閉じたときの全子孫の開閉（接頭辞境界、取得結果・loading・error の保持、後着した一覧で開きが復活しないこと）/ 削除した行だけを落として他を保つこと / 削除の confirm 文言（ファイル / 配下ごとのディレクトリ、画面の root 相対パス）/ ディレクトリ削除後の枝の prune（接頭辞境界と own プロパティ契約）/ リネームの prompt 文言と、親の行の名前差し替え・配下キーの張り替え・開閉と取得済みの子の保持（接頭辞境界・未取得の親・`__proto__`）/ 取得中のリネームで loading を落として新しいキーで取り直すこと（旧キーの応答で新キーを汚さない）/ 保存する展開の抽出と復元（root の初期化、閉じた子孫の除外、祖先がそろわない保存パスの正規化・順序非依存・`__proto__`、truncated）/ reveal の祖先（root から近い順・root 直下は空・同 object を返す条件・loading と子の保持・親を閉じた後の再展開・`__proto__`）/ パンくずの項目（root 相対の祖先とファイル）/ 取得済みの行の引き（未取得の親・一覧の上限外・前方一致・`__proto__`・再読み込み後） |
| `client/test/fileTreeReveal.test.ts` | パンくずの操作名 / root 相対の祖先とファイル / 全体パスの title / aria-current（SSR） |
| `client/test/fileRowMenu.test.ts` | 操作の採否・順序 / menu と menuitem の公開属性 / パスコピー失敗の通知の出し分け（行の中の `role="alert"`・内訳・選択の導線なし） / 位置・可視判定・キーボード移動の純関数 |
| `client/test/fileDownloadRow.test.ts` | 種類・symlink・除外名・readOnly ごとの操作の採否 / 確認文言とサイズ表記 |
| `client/test/archiveSettings.test.ts` | 除外名の下書きの純関数（実効値からの初期化と配列を共有しないこと / dirty の比較（未設定のまま既定を保存させない）/ 追加の trim・空・重複・上限 / 削除 / 検証（サーバーと同じ 1 セグメント名の規則と件数上限）） |
| `client/test/archiveExcludeSettings.test.ts` | 「ダウンロードの除外」タブの中身: 未設定・上書き・明示空・読み込み中・失敗（SSR）。HTTP は apiContracts で検査 |
| `client/test/filesSettingsPage.test.ts` | 設定 → ファイル のタブ / ヘッダ: 既定はファイルツリー、除外タブの説明・操作（保存可否）・note（SSR） |
| `client/test/sharedContentExclusions.test.ts` | 共有の除外名の検証（`index.html` の拒否 / 1 セグメント名の規則と件数上限はダウンロードの除外と同じ） |
| `client/test/sharedContentExclusionsTab.test.ts` | 設定 → 共有の「公開の除外」タブの中身: 公開だけの規則（対象ディレクトリ自身の名前 / `index.html`）・ダウンロードの除外への導線・未設定 / 上書き / 明示空 / 読み込み中 / 失敗（SSR） |
| `client/test/fileSkillPanel.test.ts` | ファイルタブの採否 / 組み込み本文の表示（SSR）。取得・タブ間の操作はブラウザで確認 |
| `client/test/fileRef.test.ts` | matcher の採否表（正規化と別表記の同ービキー / 制御文字 U+0000 / Unicode 空白 U+00A0・U+3000 / dotfile / scheme / `..` / 末尾ドット）と、cwd 相対の解決表（rootCwd 前置き / cwd 外 / rootCwd 未取得 / 明示的な相対 / cwd 未確定）、面つき解決（裸名の除外と、区切りを持つ字面の採用 / 共通スキルの絶対パス → `kind = "skill"` の root / path、補助ファイル、名前の境界、`.agents/skills` 直下・プロジェクトスキル・root 外の不採用、workspace 相対の現行維持、cwd 配下の作業フォルダ面優先 / 画像が使う matcher は裸名を採ること / 共通スキル配下のパス判定） |
| `client/test/fileMention.test.ts` | ドラッグの種類の判定 / 参照の引用とエスケープ / 挿入・カーソルの位置 / trim を通したパスの保持 |
| `client/test/fileRefRequest.test.ts` | 最新要求だけを保持 / 要求の種別と root / seq が一致する ack だけを消費 / 選択変更と sessionId の採否 / 面ごとの消費可否（作業フォルダ面がスキル要求を消費しない） / 種別からのモード決定 / セッション切替・画面の移動・layout 切替での既定への復帰 / 購読・解除 / 選択の切替世代（未消費が無くても clear で進み、request・ack では進まない）/ クリックの順序（実在を確認してから面を開く / A→B・A→B→A の逆転で最後のクリックだけが開く / セッション切替で失効（A→B→A で戻っても復活しない）/ 不存在では要求もモードも変えない / 拒否・確認不能の理由） |
| `client/test/fileRefOpen.test.ts` | 確認 API の status 分類（404 = 不存在 / 400 = 拒否 / 502・503・通信失敗 = 確認不能）/ 失敗理由の文言 / 確認先のパス写像（作業フォルダ面とスキル面）/ 確認の例外とセッション未確定で開かないこと / 切替世代をまたいだ結果の失効（A→B→A） |
| `client/test/markdownFileRef.test.ts` | 参照になる code だけ操作にする / 裸名・provider 外・cwd 外・リンク内の除外 / 引用・リスト・表での描画 / 共通スキルの絶対パスがスキル面の操作要素になり、操作名が種別で変わること（SSR） |
| `client/test/sessionSkillFiles.test.ts` | チャットのスキル面の外装（見出し / root / 戻る導線 / 閉じる導線）と、モードによる作業フォルダ面との出し分け（SSR）。行の操作は `fileRowMenu.test.ts` とブラウザ受入で確認する |
| `client/test/filePreviewState.test.ts` | 保存 schema の encode / decode / 検証と上限 / 壊れた入力の捨て方 / 他 cwd を消さない merge / read・write の例外とメモリ snapshot / 配信元（ストレージ有効モード）を保存しないこと |
| `client/test/sessionFiles.test.ts` | 右パネルの出し分け（desktop × チャット画面 × 作業フォルダあり） |
| `client/test/copyResult.test.ts` | コピー結果の controller: 所有者 (会話) の切替と unmount の invalidate をまたいで、deferred な成功 / 失敗を適用しないこと（A→B・A→B→A）/ 成功 2 秒・失敗 8 秒の表示と、切替でのタイマー破棄 |
| `client/test/sessionFilesPath.test.ts` | 帯のパスの分割（未所属の 2 段 / プロジェクトの 1 段 / 末尾の `/` / root `.` / 1 段だけ）/ 絶対パスの組み立て（root `.` は `rootCwd` そのまま・未取得は undefined）/ ⋯ の項目と disabled の理由（片方だけ・両方）/ 全 disabled で ⋯ を出さず理由を常設すること（SSR） |
| `client/test/chatReducer.test.ts` | `runEndSeq` が `run_end` と `running` を抜けた `resync` でだけ進むこと（同じバッチで届いた `run_start` / `run_end` でも 1 回、新規チャットでも戻らない） |
| `client/test/route.test.ts` | pathname と画面の対応（大文字・末尾スラッシュ・percent encoding・不正な入力の畳み方）と往復 |
| `client/test/fileUrl.test.ts` | パスのセグメント単位 encode（`#` / `?` / `%` / `+` / 日本語 / 1 回の decode で戻ること）/ `fileRawUrl` が version 指定時だけ `v` を付け、未指定時の URL を保つこと / `fileHtmlPreviewUrl` がクエリでなくパス形式で組み立てること / `fileStoragePreviewUrl` が hostname + ポートで別オリジンの URL を組み立てること |
| `client/test/filePreviewError.test.ts` | 共通スキル配下の `Path not found` にだけ補助文を出すこと（作業フォルダ側・接頭辞の別名・他のエラーでは出さない） |
| `server/test/file-stat.test.ts` | サンドボックスの `GET /v1/files/stat`（通常ファイル 200 と symlink の実パス / 本文を読まないためバイナリ・UTF-8 不正・上限超過も 200 / 不存在と壊れた symlink の 404 / ディレクトリ・root 自身・root 外・不正要求の 400 / 認証） |
| `server/test/files.test.ts` | HTML プレビューのポリシー定数（段階ごとの CSP / `connect-src` なし / リスナーごとの sandbox 段）/ `GET /api/files/html/<path>` の文書・画像・音声・テキストアセット・400 の分岐と percent decoding（音声は raw・テキストは preview の使い分けと動画 / フォントの 400 を含む）/ ヘッダ（CSP / `no-store` / `nosniff`）/ `previewApp` の storage 有効 CSP（文書は HTML・アセットは CSP 無しの JSON）とマウント範囲（HTML プレビュー ルートだけ）/ `GET /api/files/raw` が画像と音声を配り、`.svg` / `.html` / 動画 / テキストを 400 で拒むこと / `Range` の status・`Content-Range`・`Accept-Ranges` の中継（206 と 416）/ 文書は HTML・アセットは JSON のエラー写像 / `DELETE /api/files` の委譲（`recursive=true` は `deleteDirectory`）と 204・`recursive` の検証・エラー写像 / `POST /api/files/rename` の委譲と body 検証・エラー写像（409 の透過を含む）・契約外の応答の 502 / `GET /api/files/stat` の本文を取らない委譲と no-store・200 / 404 / 400 の透過・確認不能の 502 / 未設定の 503 |
| `server/test/file-preview-port.test.ts` | プレビュー オリジンのポート解決（待受とブラウザから見た値の既定はどちらも 4318 / 未設定は既定 / 1〜65535 の整数 / 不正値は throw して指定した env を名指しする / `pnpm dev` 用の統一（`PI_FILE_PREVIEW_PORT` が正・待受 env しか無いときはその値へ寄せる・空白だけは未設定）） |
| `server/test/dev-file-preview-port.test.ts` | `pnpm dev` が解決した 1 つの値を待受の空き確認と BFF の両 env（`PI_FILE_PREVIEW_PORT` / `PI_FILE_PREVIEW_LISTEN_PORT`）へ渡し、既定ポートを直書きしないこと（ソース走査） |
| `server/test/archive-rules.test.ts` | 既定の除外名（再生成物 / ビルド成果物 / `vendor` などを入れない）/ 上書きの解決（空配列は全解除・trim と重複の除去・呼び出し側の変更から既定を守る）/ 正規化（trim / 空落とし / 先勝ちの重複 / 順序と大文字小文字の保持）/ 検証（`.`・`..`・区切り・制御文字・200 文字超・100 件超）/ `GET /api/health` が実効値を返すこと |
| `server/test/archive-settings.test.ts` | 設定ストア（未設定 = 既定 / 保存の正規化と明示空 / リセットで行を消す / 検証エラーの 400 と非破壊 / DB 不可のフォールバックと 503）とルート（GET / PUT / DELETE の同じ形 / zod の 400 / 再起動後の保持 / DB 不可の 503）/ 整合（PUT の直後に health と download / check が同じ実効値を見る） |
| `server/test/zip-writer.test.ts` | ZIP ライタ（既知ベクタの CRC32 と分割入力 / store と deflate の選択 / UTF-8 名と bit 3・bit 11 / 空ファイル・空ディレクトリ / 複数チャンク / 途中失敗でストリームを失敗させる） |
| `server/test/sandbox-archive.test.ts` | `GET /v1/files/download` と `/check`（zip の中身と除外 / skipped の内容 / `exclude` の省略 = 既定と空値のみ = 除外なし / 繰り返しの一覧 / 不正名と 100 件超の 400 / 除外名のディレクトリの 400 / symlink の 400 と配下 symlink の除外 / 単体ファイルの生配信とヘッダ / root の zip / 空ディレクトリ / 末尾スラッシュ / 404・root 外 400・`..` の 400 / 上限 413 / 認証） |
| `server/test/file-download.test.ts` | BFF の `GET /api/files/download` と `/check`（ストリーム中継とヘッダ / `Content-Disposition` の透過 / `Content-Length` の有無 / 設定ストアの実効値を `exclude` の繰り返しで渡すこと（未設定 = 既定 / 明示空 = 空のまま）/ 400・404・413・502・503 の写像 / 契約外の check 応答の 502） |
| `server/test/sandbox-delete-dir.test.ts` | `DELETE /v1/dirs`（`recursive` の解釈 / 空ディレクトリ / 非空の 400 と部分削除なし / 配下ごとの削除と接頭辞境界 / パス形式と root 外・不存在・非ディレクトリ・symlink の 400・404 / 配下 symlink のリンクだけの削除 / 一覧上限外の子 / `__proto__` / 認証） |
| `server/test/sandbox-client.test.ts` | NDJSON / JSON 経路の写像と、`deleteDirectory` が `DELETE /v1/dirs?recursive=true` を呼び 204 の本文を読まないこと / `renameEntry` が `POST /v1/files/rename` を呼び、409 を文言ごと透過すること / `rawFile` が `Range` を付けて送り status・`Content-Range`・`Accept-Ranges` を中継すること（416 は例外にしない） |
| `server/test/sandbox-rename.test.ts` | `POST /v1/files/rename`（ファイル / ディレクトリの改名と応答パス / 大文字小文字だけの変更 / 同名 409 と変更なし / 不正な名前・パス形式の 400 / 不存在 404 / root 外 400 / symlink の 400 とリンク先の維持・symlink への上書きの 409 / symlink ディレクトリ経由 / 認証） |
| `server/test/static.test.ts` | SPA フォールバック（拡張子なしの画面 URL / `/api`・`/assets` の境界 / `Accept` / 未ビルド 503）と、アプリ CSP の `frame-src`（`'self'` + プレビュー オリジンのポート）と `media-src 'self' blob:`（お試し再生の blob URL） |

## 参照

- [ui-layout.md](ui-layout.md) — 本文の中でツリーとプレビューをどう並べるか
- [markdown.md](markdown.md) — 共有するトークナイザの対応言語・上限と、インラインコードをファイル参照の操作要素にする描画契約
- [api-files.md](api-files.md#テキストプレビュー) — プレビューの転送契約
- [api-files.md](api-files.md#html-プレビュー) — HTML プレビューのヘッダとエラー応答
- [api-files.md](api-files.md#ダウンロード) — ダウンロードの転送契約
- [sandbox-api.md](sandbox-api.md#get-v1filesdownload) — ZIP の除外規則・上限・ZIP ライタの実装
- [api-files.md](api-files.md#アーカイブの除外名) — 除外名の設定 API（未設定と明示空の区別・検証）
