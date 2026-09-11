# モノレポへの移植

## 移植元と履歴

- 移植元: ローカルリポジトリ `/home/u7dev/workspace/aiagent`
- 元コミット: `54def1abca7d6de1fae398775a5d5cdbdf206ee4`（11コミット）
- 移植先: `projects/pi-agent-gui`（移植当時は `projects/_labs/pi-agent-gui`）

元の追跡ファイルをスナップショットとして取り込みました。`node_modules`、ビルド成果物、Playwrightの一時ファイル、`.git` は取り込んでいません。元リポジトリは変更していません。

PRはsquash mergeを想定しているため、元の個別コミットはモノレポの履歴には入りません。元の全履歴は移植作業環境の `/home/u7dev/workspace/aiagent-history.bundle` に保存し、`git bundle verify` で検証済みです。bundleはこのリポジトリには含めていません。

復元例（bundleの保管場所に合わせてパスを指定）:

```bash
git clone /path/to/aiagent-history.bundle aiagent-history
```

## 移植時の変更

- client/serverのworkspace構成と、Honoの型をclientから参照する構成を維持
- pnpm 12.3.4から既存CIで使用する10.34.5に変更し、lockfileを再生成
- 依存はmanifestの範囲内で再解決。元のlockfileとの完全なバージョン一致は保証しない
- 未確定文字列だった依存ビルド設定をpnpm 10の `onlyBuiltDependencies: [esbuild]` に置換
- 起動に必要な `tsx` をserverの本番依存へ移動
- Dockerの `test` / `final` ステージと実行手順を追加
- モノレポのライセンス対象検出を、pnpm workspaceの共有lockfileに対応
- 移植元の関数名・ファイル名を指すコメント（「port 元 …」「旧 …」）は、対応関係がこの文書と上記の元コミットで追えるため削除し、コメントは理由・制約の説明だけに絞った

## 昇格時の変更

- `projects/_labs/pi-agent-gui` から `projects/pi-agent-gui` へ移動
- Dependabotの対象に追加し、依存更新はDependabotで追う（`package-ecosystem: "npm"`）

## 検証状況

UI・モデル実行機能は網羅的に検証していません。APIテストではモデルをスタブに置き換えており、実API呼出し・OAuth更新・ブラウザ操作の検証は別途行います。
