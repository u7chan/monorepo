# テスト方針と GUI 受入

追加時の判断基準は [AGENTS.md](../AGENTS.md#テスト方針)。実行は `pnpm check`。server の API・sandbox・secrets・session persistence テストは減らさず、client の reducer、parser、パス解決、保存・fallback、制御ロジックも自動テストする。

サービスの公開経路は server 側の振る舞いテストで固定する。`server/test/service-proxy.test.ts` が、3 本目のリスナーからサンドボックスの 8080 への転送（メソッド / パス / クエリ / ボディ / ストリーミング / `Range` / `Content-Encoding` の透過、ホップバイホップ ヘッダの除去）、キャッシュ ヘッダの `Cache-Control: no-store` への正規化、GET / HEAD の再検証ヘッダの遮断、`Location` の書き換え、上流停止時の 502 を検査する。ポートの解決（`PI_SERVICE_LISTEN_PORT` / `PI_PREVIEW_PORT`）と `pnpm dev` が同じ値を渡すことは `server/test/preview-port.test.ts` が検査する。

## スペースの受入

自動検証は `server/test/spaces-api.test.ts`（加算移行・複数所属・live / 未ロード / sweep / 再起動・添付 / cwd・復元前の所属拒否・プロジェクト利用拒否・DB 障害時の通常停止 / 削除）、`client/test/spaces.test.ts`（既定の保存先の解決・選択の fail-closed・初期選択の優先順位・各 API の文脈・作成待ちの要求元固定・遅い一覧応答）と既存の session / API / fallback / 通知リンクテストで行う。GUI は専用の一時ストア / workspace / ポートと stub pi を使い、実データや有料 API に触れない。

desktop と compact の両方で次を確認する。

- 通常から新しい追加スペースへ切り替えると空の会話一覧・新規会話になり、Projects / New Project と「未所属」が出ない。左バーの選択名が合う。設定 → スペース（`/settings/spaces`）は追加スペースが増えても一覧が縦に伸びず、作成フォームが画面内に残る（残りは一覧の内部スクロールで選ぶ）。
- 会話を送信し、添付・作業フォルダ・環境変数・サービス操作が追加スペースの cwd を使う。共通スキルは利用でき、設定 → ファイルは workspace 全体を表示する。
- 通常へ戻ると既存のプロジェクトと会話が戻り、追加スペースへ戻るとデモ会話が残る。切替だけではランを停止せず、戻って結果を確認できる。
- 入力中・添付中・作成待ち・実行中に切り替え、旧下書き・添付・ファイル面・先行選択・遅い成功 / 失敗 / busy が新しい表示へ混ざらない。後続の送信 / upload は開始元の所属で続行する。
- 設定保存後のカタログ再取得を遅延させ、待機中にスペースを切り替えて別のエージェントを選ぶ。旧応答後も共有保存値が巻き戻らず、リロード・再切替後に選択を保つ。mount 世代の失効と共有保存値の保護は `client/test/mountScope.test.ts` でも検証する。
- スペースを選んでタブを閉じて開き直す / ブラウザーを再起動 / 新しいタブで開くと、同じスペースが復元される。`localStorage` を消すと通常スペース、保存 ID を未知 / 不正へ変更するか一覧取得を失敗させると、理由と選び直し / 再取得を出し、通常の会話を誤表示しない。
- 他タブで切替えても既存タブは変わらず、そのタブのリロードで追随する（最後に書いた値が正になる）。
- 他スペースの `/s/<sessionId>` は会話を開かず既存の見つからない旨を出し、自動切替しない。通知リンク / 設定 → ランタイムの「起動元の会話」のリンク（`?space=`）は保存値が別のスペースでもその会話の所属で開き、開いた後に URL から `space` が消える（他のクエリとフラグメントは残る）。`?space=` が未知なら復旧画面になり、選び直した後に F5 しても復旧画面へ戻らない。プロジェクト dialog / ファイル面の残存や操作不能、SSE 再接続・削除後 fallback の混線が無い。

### 有料 API を使わない GUI fixture

プロジェクト root で `ROOT=$(mktemp -d /tmp/u7agent-spaces-e2e-XXXXXX)` を作成し、同じ ROOT を各ターミナルに渡す。既存の `.env` や本番ストアを使わない。ポートが空いていることを確認して次を別プロセスで起動する（競合時は 3 ポートとも別の空き値へ変える）。

```bash
# terminal 1: 実ファイル操作用の一時サンドボックス
PI_SANDBOX_CWD="$ROOT/workspace" PI_SANDBOX_TOKEN=spaces-e2e-local-token \
  SANDBOX_HOST=127.0.0.1 SANDBOX_PORT=17991 pnpm --filter server start:sandbox

# terminal 2: 認証情報・LLM を使わない stub pi の BFF
U7AGENT_FIXTURE_ROOT="$ROOT" PI_SANDBOX_URL=http://127.0.0.1:17991 \
  PI_SANDBOX_TOKEN=spaces-e2e-local-token PORT=17990 \
  pnpm --filter server exec tsx test/spaces-fixture.ts

# terminal 3: UI（通常の pnpm dev は起動しない）
PORT=17990 pnpm --filter client exec vite --host 127.0.0.1 --port 17992 --strictPort
```

`http://127.0.0.1:17992` を開く。fixture は通常のプロジェクトと会話を 1 件ずつ用意し、再起動時は既存データを保持する。stub の応答は実ツールを呼ばないため、モデルによるファイル生成は受入結果に含めない。live 行は stub が流す 3 つのシナリオで受入できる。`investigate` の進捗は依頼文（例: 「リポジトリの docs 構成を調べ…」）で、連続ツール呼び出し（速い順次 + 並列）は本文に `連続ツール` を、畳みはじめの窓に届く一瞬の行は `畳み窓` を含めて送ると始まる（後者は最後のツールが終わって箱が畳みはじめた頃に、start と end が同じ時刻の行が 1 本だけ届く。**有料 API なしで何度でも再現できる**）。添付 / ファイル画面は実サンドボックス経由で確認できる。遅い要求や取得失敗はブラウザの routing で注入する。実サービスの公開・モデル / 画像 / 検索設定の外部通信は使わない。終了後は全プロセスを停止して、この ROOT だけを削除する。

## client の棚卸し

整理前のローカル checkout は `client/test/*.test.ts` が 119 ファイル、うち `readFileSync` を使うものが 61 ファイルだった。ファイル数ではなくテストケース単位で分類し、混在する純関数・SSR の検査は残した。以下のファイル名は `client/test/` 相対。

| 分類 | 対象と扱い |
| --- | --- |
| 振る舞いへ置換 | `historyWiring` → `apiContracts` で実 fetch の要求・応答・エラーを検査。履歴のページ追加・gap fill・resync は既存の `chatHistory` / `historyResync` / `chatReducer` に集約 |
| 振る舞いへ置換 | `navDrawerMotion` → `animationEnd` で終了イベント・子のイベントの除外・イベントなしの timeout・二重完了の防止・cleanup を検査。`cssTime` の時間 parser は維持 |
| 振る舞いへ置換 | `fileSkillList` / `skillSelector` / `settingsDetailSheet` / `toggleSwitch` は実コンポーネントの描画属性・内容を検査。スイッチの callback は実 handler を呼ぶ |
| 振る舞いへ統合 | `filePreviewCopy` / `filePreviewImage` / `filePreviewNewTab` のうち画像 URL・メタ、HTML の sandbox・配信元、別タブの `noopener` と操作名は `filePreviewStorageMode` の SSR へ。コピー本文の正規化は `fileCode`、タブの状態は `fileTabs`、保存は `filePreviewState` に集約 |
| 純関数・描画を維持 | `agentLabel` / `agentPicker` / `archiveSettingsPage` / `chatScopeWiring` / `chatScroll` / `compaction` / `composerEnter` / `fileCode` / `fileDownloadRow` / `fileRefRequest` / `fileRowMenu` / `fileTreeReveal` / `fileTreeWidth` / `fileTreeHeight` のコード断片・レイアウト検査だけを除去 |
| 純関数・描画を維持 | `imageZoom` / `markdownCodeBlock` / `markdownFileRef` / `markdownImage` / `modelSettingsPage` / `notifyToggle` / `readOnlySkillPanel` / `runRetry` / `serveStatus` / `servedApp` / `sessionFilesPanel` / `sidebarOverlay` / `sidebarProjects` / `sidebarRowMenu` / `sidebarWidth` / `skillPicker` / `skillSettingsPage` / `userMessageCollapse` の wiring 検査だけを除去 |
| 純関数へ集約 | `fileMention` は判定・挿入・引用を維持。`markdownHighlight` は言語・トークン分解・上限を維持し、CSS 色の定義数は検査しない。`markdownDiagram` の DOM 禁止検査は `markdownSafety` と重複していたため除去 |
| 手動受入へ | `activityShimmer` / `popoverPanel` / `mobileOverflow` / `fileBrowserScrollGutter` / `sidebarScrollGutter` / `fileBrowserRowTime` / `fileTreeFold` は具体的な CSS・配置の検査を除去。`markdownTable` は表の描画を残し、折り返し・スクロール・整列はブラウザで確認 |
| 既存契約へ集約 | `fileBrowserRename` の出し分けは `fileRowMenu`、経路の張り替えは `fileTree` / `fileTabs`、API・非破壊性は server テストで検査。`sessionRename` の PATCH は `apiContracts`、操作の表示は `sidebarRowMenu` に集約し、prompt と画面反映はブラウザで確認 |
| lint / typecheck へ | `u7AgentContract` の facade 名・export 名、props の有無、import・関数名・hook 名の文字列検査を除去。起動・選択・古い応答の採否は `sessionFallback` / `pendingSessionOpen` / `sessionActions` 等の制御ロジックを維持 |
| 限定的な検査を維持 | `eventInStateUpdater` / `markdownSafety` / `filePreviewSafety` / `themeSync` / `providerIcon`。`fileCode` に混在していた安全性検査は `filePreviewSafety` に分離。理由と範囲は次節 |

source scan を消しただけではイベント伝播・実 DOM の焦点・hook 間の連携の回帰を保証できない。SSR は公開属性と内容だけを検査し、ネイティブ dialog / popover、スクロール、ResizeObserver、実際のクリック領域は次の受入で確認する。DOM / browser test の新規依存や巨大な E2E suite は追加しない。

## 残す限定的な検査

- `eventInStateUpdater.test.ts`: React の遅延 updater 内でイベントを読むと入力で画面が落ちる。型ではイベント寿命を保証できないため、禁止パターンの検査を残す。文字列走査は lint 相当の補助で、すべての alias や構文を解析するものではない。
- `markdownSafety.test.ts`: Markdown 由来の DOM 文字列生成とインライン style の禁止を、parser / renderer のディレクトリ配下（子ディレクトリも含む）に限定して検査する。ファイル名一覧は契約にしない。入力の安全性は既存 parser の採否テストと併用する。
- `filePreviewSafety.test.ts`: ファイルのソース表示も HTML 挿入・HTML パース・インライン style を禁止する。`lib/fileCode.ts` / `components/FilePreview.tsx` は Markdown の検査範囲外で、取得後の本文描画は SSR の初期状態では通らないため、型・SSR で代替できない安全性検査だけを残す。本文描画を移す場合は対象を追随させ、CSS・helper 名・props の wiring は検査しない。
- `themeSync.test.ts`: 初回描画前の classic script を VM で実行し、保存値・system・利用不能時の解決を検査する。CSS と TypeScript の registry は型で結べないため、プリセット・スウォッチのキーと `color-scheme` の対応だけは走査する。配色・余白・演出は固定しない。
- `providerIcon.test.ts`: 配布物にロゴの帰属表示とライセンスが同梱される契約。実装ソースの wiring ではなく成果物を読む。

## GUI の最小受入

チャットの末尾追従は、`pnpm dev` で起動した実画面に対し、Playwright スキルの `pw.sh` から次の受入スクリプトを実行できる（モノレポルートを cwd にする）。API と SSE をブラウザ内でスタブするため LLM は呼び出さない。新しい headless セッションで実行し、終わったら `close` する。

```sh
pw.sh open http://localhost:3000/
pw.sh run-code --filename=projects/u7agent/scripts/check-chat-scroll.js
pw.sh close
```

`?narrow` を URL に付けると 390×844 で検証する。300 行の表の配信中、rAF で測った末尾からの距離が 1px 以内であること、読み返し中は追従せず、最新へ戻る操作と容器のリサイズで追従することを検査する。表そのものの折り返しや、履歴の前置き・会話切替の受入は次のチェックリストで別途確認する。

見た目は次の viewport で確認する。**pixel 単位の実測値を docs に残さない**（ここで見て、結果は PR に書く）。視覚調整の変更ごとに全画面の pixel-perfect 比較はしない。

| 用途 | viewport |
| --- | --- |
| desktop | 1440x900 |
| tablet | 820x1180 |
| phone portrait | 390x844 |
| phone landscape | 844x390 |
| 低いウィンドウ | 1440x500 |

- [ ] チャットと設定（エージェント・スキル・ファイル・モデル）で長い名前・パス・本文が viewport の横にはみ出さず、操作が押せる。表・コードの内部横スクロールは許容する。
- [ ] サイドバーの `Projects` と `未所属` を独立して開閉でき、開閉状態がリロードと docked / drawer の切替後も保たれる。閉じた配下へ Tab で入らず、reduced motion では遷移が止まる。
- [ ] ドロワーが Escape・背景・閉じる・新規会話・設定項目の選択で閉じる。animation を無効にしても閉じられる。
- [ ] ドロワーから New Project を開き、追加 dialog を閉じたあと焦点が有効な操作に戻る。開いたまま docked に広げる／設定とチャットを切り替えても操作不能にならない。
- [ ] エージェント選択・スキル一覧・行の ⋯ が開閉でき、矢印キーと Enter、Escape、Tab で操作できる。Escape が別の画面まで閉じない。
- [ ] compact の詳細シートと画像拡大を Escape で閉じても、背面の画面は変わらず焦点が戻る。
- [ ] 確認・入力のダイアログ（サービスの置き換え / 削除 / 圧縮 / リネームなど）が Escape と「キャンセル」で閉じ、閉じた後に開いたボタンへ焦点が戻る。初期焦点は確認なら「キャンセル」、入力なら現在値を選択した入力欄にする。対象の長い名前は 2 行で clamp され、全文は hover で読める。compact でも同じ見た目で操作でき、取り消したら後続の処理（削除・起動など）が走らない。別の確認を待たせている場合は、先の応答の後に順番に出る。
- [ ] ファイルツリーの折りたたみで隠れた枝へ Tab が入らない。親フォルダを閉じると配下の子孫も閉じ、開き直しても子孫は閉じたまま。画面往復・F5 後もその状態が復元され、開いているファイルのタブと表示モードは維持される。
- [ ] 設定 → モデル（プロバイダー / コンテンツ生成（`/settings/models/content`）/ Web 検索）と設定 → ダウンロード（`/settings/archive`）と設定 → スペース（`/settings/spaces`）のオレンジの注意書きが既定で 1 行に畳まれ、展開で全文が読める。折りたたみ中も要点（平文保存・送信先・共有範囲など）が読め、reduced motion でも開閉できる。
- [ ] 作業環境パネルでは `.git` がルート・ネストとも出ず、設定 → ファイル では出る。ファイル行のサイズが narrow の 2 段でも崩れずに出る。パンくず・参照からの reveal、タブの選択・×・中クリック、ソースのコピーが動く。
- [ ] ファイルの HTML 配信元の切替・別タブ、Markdown のソース / プレビュー切替とプレビュー内の画像、画像のメタ、保存・F5 復元が動く。リネームと削除の取消で状態を変えない。
- [ ] **Safari（macOS / iOS）**で作業フォルダの音声（`mp3` / `m4a` / `ogg` / `oga` / `wav` / `flac`）を開いて再生・一時停止・シークできる。WebKit は `<audio>` の読み込みに `Range` と 206 を要求するため、応答が 200 固定だと無言で再生できない（契約は [api.md](api.md#画像配信raw)）。`<audio>` の再生可否はブラウザーのコーデック依存なので、再生できない形式があっても配信の不具合と扱わず、形式ごとの可否を結果に書く
- [ ] チャット本文の共通スキルの絶対パス（`.agents/skills/<name>/SKILL.md`）から右パネル / sheet にスキル面が開き、対象のファイルが見える。スキル A → B の切替、作業フォルダの参照との往復（逆向きも）、「作業フォルダへ戻る」/ ✕ / `Escape`、セッション切替 / 新規チャット / チャット以外への移動で作業フォルダ面（既定）へ戻る。作業環境パネルには誤適用しない（導線の期待値は [ui-layout.md](ui-layout.md#作業環境パネル)）
- [ ] パネルのリサイズがドラッグ・←→・Home/End で動き、境界に収まり、操作後と再表示で幅を保つ。右パネルは左右 2 段にならない面なので、**コード表示（行番号の列）を開いた状態でも境界の左端を掴める**（行番号の列は `position: sticky` で境界に重なる。[ui-layout.md](ui-layout.md#作業環境パネル)）
- [ ] 会話の送信／切替／ファイル面の開閉でスクロール追従と履歴追加が動く。読み返し中の位置を勝手に最新へ戻さない。
- [ ] スクロール追従の細目: 追従中はユーザー操作なしにボタンが出ない（大きな tool 出力が続く場面）/ snap の直後に上へスクロールしても引き戻されない / **追従中（`dist <= 48`）に右パネルを開閉しても `dist <= 48` のままでボタンが出ない** / 48px 以内へ自分で戻すと追従が再開する / 読み返したまま送信すると最下部へ戻る（post の失敗時も最下部に居続け、理由は状態行に出る）/ 再接続（resync）で強制的に最下部へ飛ばない / 追従中はコンポーザの伸縮・右パネルのドラッグ・リサイズで離れない / メッセージ 0 件ではボタンが出ず、キーボードで到達できて既存の `Escape` を妨げない
- [ ] 作業先と作業フォルダの導線: 起動 / リロードで見出しはキャッチコピー・チップは未所属・パネルは閉 / プロジェクト配下のセッションで「新しい会話」を押すと未所属になってパネルが閉じる / プロジェクト行の ⋯ とプロジェクトの追加（新規・既存登録のどちらも）で見出しとチップがそのプロジェクトになり、送信前に右パネルが開く（compact ではシートを開かない）/ 追加に失敗しても見出し・チップ・パネルが変わらない / プロジェクト行のクリックと添付・送信でパネルの開閉が動かない / パネルを手で閉じてから別セッションへ移っても勝手に開かない / 設定ページを往復しても開閉が変わらない / desktop で開いたまま狭めてもシートが一瞬も出ず、戻ると同じ開閉で出る / 選択待ち（GET 中）はチップ・見出し・root が旧表示のままで応答で切り替わる（期待値は [ui-layout.md](ui-layout.md#作業先と作業フォルダの導線)）
- [ ] **実機**（iOS Safari / Android Chrome）の compact で入力欄から送信するとソフトキーボードが閉じる。デスクトップのマウス（PC 幅と、幅 / 高さが足りない compact の窓）では送信後も入力欄のフォーカスが残り、続けて入力できる。compact の入力欄は一次ポインタのタッチ判定（`(pointer: coarse)`）で分かれるので、実機のポインタで見る（[送信後の入力欄のフォーカス](ui-layout.md#送信後の入力欄のフォーカス)）
- [ ] `ask_user` のカードが質問を 1 問ずつ出し、`1 / N` と前後で回答せずに切り替えられる。選択肢（multiSelect を含む）・自由記入・「回答しない」・`✕` で回答でき、回答後は Q&A の記録になる。回答待ちの間は入力欄の送信が無効になり（停止は押せる）、本文を持たない assistant でも F5 / SSE 再接続後にカードが残る。停止で「回答なしで終了」になり、`→` は回答が入るまで押せず、最後の質問で未回答が残るとその質問へ戻る。**日本語 IME の変換確定 Enter では次の質問へ進まない**。desktop と compact の両方で見て、compact ではキーボードで送信ボタンが隠れないかも確認する
- [ ] 入力欄への画像の貼り付けでチップが出て、テキストだけの貼り付けは本文へ入る。チップのサムネイルが出て、クリックで拡大表示できる。desktop は Ctrl+V / Cmd+V、モバイルは長押しメニューのペーストで確認する（モバイルの `textarea` は画像を挿入しないため入力欄は空のままになる。これを失敗と扱わずチップの有無で判定する）。HTTP の LAN IP でも成立し、secure context は要らない（[添付ファイル](session-files.md#添付ファイルチャットからのアップロード)）
- [ ] 有料 API を使わない GUI fixture で `investigate` の live 行に現在の活動と子の本文末尾（1 行、左罫線付き）が出て、完了すると要約カード 1 枚になる。リロード後は進捗が消えて要約カードだけが残る（進捗は live 専用。契約は [subagent.md](subagent.md#進捗)）。実行中の stop で live 行が畳まれる
- [ ] 有料 API を使わない GUI fixture の連続ツール呼び出しで、live の箱が入力欄の上に浮き、行が出入りしても追従中の本文が動かない。箱は最新の枠までを出して溢れた分を「…他 N 件」に畳み、**実行中の行は並列でも窓から消えない**。下端の余白は最後の本文を隠さず、閉じるときは箱・行・余白がまとめて畳まれる。`investigate` の進捗は 1 行で読める。**箱が開いている間も「最新のメッセージへ移動」ボタンが見えて押せる**（押すと最下部へ戻る）。desktop と compact の両方で見る（読み返し中は余白が即時に外れ、箱は本文に重なる）
- [ ] 有料 API を使わない GUI fixture の `畳み窓` シナリオで、箱が畳みはじめた後に届いた一瞬の行も 900ms 読める（畳みはじめが解除されて箱が開き直す）。reduced motion では、箱の開閉と余白の確保/解放がどちらも 1 フレームで起きる（閉じる側にも transition を残さない）
- [ ] reduced motion でも操作不能にならず、light / dark で本文と操作名が読める。forced colors で活動表示が消えない。popover の出入りとスクロールバー出現時に明確な表示崩れがない。

変更 PR には実施した viewport・導線と未実施項目を記載する。受入を実施していないのに source scan の成功で代用しない。
