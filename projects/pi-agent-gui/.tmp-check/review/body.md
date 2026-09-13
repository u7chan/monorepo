**LGTM**

Nit の指摘を 1 件コメントしました。

compact で百分率を残して絶対値を省く判断、未作成セッションで非表示にする判断、compaction 後の不明値をゼロと区別する扱いは妥当です。React のクライアント描画は style.width / style.minWidth を直接設定しており、現状の CSP のために別実装へ変更する必要はありません。SSR の style 属性へ移行する場合は再検証が必要です。progressbar の名前・範囲・不明時の aria-valuenow 省略も適切です。

pnpm test と pnpm typecheck は成功しました。純粋関数テストは主要な分岐をカバーしていますが、DOM / CSP / 読み上げの回帰までは自動検証していません。今回は実ブラウザでの再検証は実施していません。
