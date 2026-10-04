# テスト方針と GUI 受入

追加時の判断基準は [AGENTS.md](../AGENTS.md#テスト方針)。実行は `pnpm check`。server の API・sandbox・secrets・session persistence テストは減らさず、client の reducer、parser、パス解決、保存・fallback、制御ロジックも自動テストする。

サービスの公開経路は server 側の振る舞いテストで固定する。`server/test/service-proxy.test.ts` が、3 本目のリスナーからサンドボックスの 8080 への転送（メソッド / パス / クエリ / ボディ / ストリーミング / `Range` / `Content-Encoding` の透過、ホップバイホップ ヘッダの除去）、キャッシュ ヘッダの `Cache-Control: no-store` への正規化、GET / HEAD の再検証ヘッダの遮断、`Location` の書き換え、上流停止時の 502 を検査する。ポートの解決（`PI_SERVICE_LISTEN_PORT` / `PI_PREVIEW_PORT`）と `pnpm dev` が同じ値を渡すことは `server/test/preview-port.test.ts` が検査する。

## client の棚卸し

整理前のローカル checkout は `client/test/*.test.ts` が 119 ファイル、うち `readFileSync` を使うものが 61 ファイルだった。ファイル数ではなくテストケース単位で分類し、混在する純関数・SSR の検査は残した。以下のファイル名は `client/test/` 相対。

| 分類 | 対象と扱い |
| --- | --- |
| 振る舞いへ置換 | `historyWiring` → `apiContracts` で実 fetch の要求・応答・エラーを検査。履歴のページ追加・gap fill・resync は既存の `chatHistory` / `historyResync` / `chatReducer` に集約 |
| 振る舞いへ置換 | `navDrawerMotion` → `animationEnd` で終了イベント・子のイベントの除外・イベントなしの timeout・二重完了の防止・cleanup を検査。`cssTime` の時間 parser は維持 |
| 振る舞いへ置換 | `fileSkillList` / `skillSelector` / `settingsDetailSheet` / `toggleSwitch` は実コンポーネントの描画属性・内容を検査。スイッチの callback は実 handler を呼ぶ |
| 振る舞いへ統合 | `filePreviewCopy` / `filePreviewImage` / `filePreviewNewTab` のうち画像 URL・メタ、HTML の sandbox・配信元、別タブの `noopener` と操作名は `filePreviewStorageMode` の SSR へ。コピー本文の正規化は `fileCode`、タブの状態は `fileTabs`、保存は `filePreviewState` に集約 |
| 純関数・描画を維持 | `agentLabel` / `agentPicker` / `archiveSettingsPage` / `chatScopeWiring` / `chatScroll` / `compaction` / `composerEnter` / `fileCode` / `fileDownloadRow` / `fileRefRequest` / `fileRowMenu` / `fileTreeReveal` / `fileTreeWidth` のコード断片・レイアウト検査だけを除去 |
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

desktop（例: 1280×900）と narrow（例: 390×844）で確認する。関連する変更では landscape（844×390）も見る。視覚調整の変更ごとに全画面の pixel-perfect 比較はしない。

- [ ] チャットと設定（エージェント・スキル・ファイル・モデル）で長い名前・パス・本文が viewport の横にはみ出さず、操作が押せる。表・コードの内部横スクロールは許容する。
- [ ] ドロワーが Escape・背景・閉じる・新規会話・設定項目の選択で閉じる。animation を無効にしても閉じられる。
- [ ] ドロワーから New Project を開き、追加 dialog を閉じたあと焦点が有効な操作に戻る。開いたまま docked に広げる／設定とチャットを切り替えても操作不能にならない。
- [ ] エージェント選択・スキル一覧・行の ⋯ が開閉でき、矢印キーと Enter、Escape、Tab で操作できる。Escape が別の画面まで閉じない。
- [ ] compact の詳細シートと画像拡大を Escape で閉じても、背面の画面は変わらず焦点が戻る。
- [ ] ファイルツリーの折りたたみで隠れた枝へ Tab が入らない。ファイル行のサイズが narrow の 2 段でも崩れずに出る。パンくず・参照からの reveal、タブの選択・×・中クリック、ソースのコピーが動く。
- [ ] ファイルの HTML 配信元の切替・別タブ、画像のメタ、保存・F5 復元が動く。リネームと削除の取消で状態を変えない。
- [ ] パネルのリサイズがドラッグ・←→・Home/End で動き、境界に収まり、操作後と再表示で幅を保つ。
- [ ] 会話の送信／切替／ファイル面の開閉でスクロール追従と履歴追加が動く。読み返し中の位置を勝手に最新へ戻さない。
- [ ] reduced motion でも操作不能にならず、light / dark で本文と操作名が読める。forced colors で活動表示が消えない。popover の出入りとスクロールバー出現時に明確な表示崩れがない。

変更 PR には実施した viewport・導線と未実施項目を記載する。受入を実施していないのに source scan の成功で代用しない。
