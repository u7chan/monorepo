# Docker Container Portal - Phase 1 タスクプラン

## 概要
Bun.serve() + React + TypeScriptでDocker Container Portalを構築する最初のタスクプラン。

## 前提条件
- 現在のプロジェクト構成: `bun init`生成のBun + React構成
- バックエンド: Bun.serve()（Expressは使用しない）
- フロントエンド: React + TypeScript + Tailwind CSS
- Docker連携: dockerodeパッケージ

---

## Phase 1: 環境構築と依存関係

### タスク1.1: dockerodeパッケージの追加
**目的**: Docker APIにアクセスするためのライブラリを追加
```bash
bun add dockerode
bun add -d @types/dockerode
```

**成果物**:
- package.json更新
- bun.lock更新

### タスク1.2: 型定義の準備
**目的**: Dockerコンテナ情報の型を定義
- Container型の定義（Ports, Names, Image, Stateなど）
- APIレスポンス型の定義

**成果物**:
- `src/types/container.ts` - コンテナ関連の型定義

---

## Phase 2: バックエンド実装

### タスク2.1: Docker APIサービスの作成
**目的**: Dockerodeを使ってコンテナ情報を取得するサービス層

**実装内容**:
- Dockerodeクライアントの初期化
- listContainers()のラッパー関数
- ポート情報のパース処理
- エラーハンドリング

**成果物**:
- `src/services/docker.ts` - Docker APIサービス

### タスク2.2: APIエンドポイントの追加
**目的**: /api/containersエンドポイントを実装

**実装内容**:
- GET /api/containers - 全コンテナ一覧
- ポート情報を整形して返却

**成果物**:
- `src/index.ts` 更新 - ルート追加

---

## Phase 3: フロントエンド実装

### タスク3.1: コンテナカードコンポーネントの作成
**目的**: 個別のコンテナ情報を表示するカードコンポーネント

**実装内容**:
- ContainerCardコンポーネント
  - コンテナ名表示
  - イメージ名表示
  - ステータスバッジ（running/stopped）
  - ポートリンク一覧
- Props型定義

**成果物**:
- `src/components/ContainerCard.tsx`

### タスク3.2: コンテナリストコンポーネントの作成
**目的**: カードをグリッドレイアウトで表示

**実装内容**:
- ContainerListコンポーネント
- グリッドレイアウト（レスポンシブ対応）
- ローディング状態
- エラー表示

**成果物**:
- `src/components/ContainerList.tsx`

### タスク3.3: メインページの更新
**目的**: App.tsxをDocker Portalのメインページに変更

**実装内容**:
- タイトルヘッダー
- フィルターボタン（全て/実行中）
- 定期更新（30秒ごと）
- サイバーパンク/テック系のデザイン適用

**成果物**:
- `src/App.tsx` 全面書き換え

---

## Phase 4: スタイリング

### タスク4.1: サイバーパンク/テック系デザインの適用
**目的**: 美しいUIを実現

**実装内容**:
- Tailwind CSSカスタム設定（必要に応じて）
- ダークテーマ
- グロー効果、アニメーション
- カードホバーエフェクト
- ポートリンクのスタイリング

**成果物**:
- `src/index.css` 更新
- `tailwind.config` 更新（必要に応じて）

---

## Phase 5: Docker設定

### タスク5.1: Dockerfileの作成
**目的**: コンテナ化

**実装内容**:
- マルチステージビルド（必要に応じて）
- Bunランタイム使用
- Docker socketマウント設定

**成果物**:
- `Dockerfile`

### タスク5.2: docker-compose.ymlの作成
**目的**: 簡単なデプロイ

**実装内容**:
- サービス定義
- ポートマッピング（3000:3000）
- Docker socketマウント（:ro）
- 再起動設定

**成果物**:
- `docker-compose.yml`

---

## Phase 6: テストと検証

### タスク6.1: APIの手動テスト
**目的**: /api/containersが正しく動作することを確認

**手順**:
1. `bun dev`で開発サーバー起動
2. curlまたはブラウザで/api/containersにアクセス
3. コンテナ情報がJSONで返却されることを確認

### タスク6.2: UIの検証
**目的**: フロントエンドが正しく表示されることを確認

**手順**:
1. ブラウザで http://localhost:3000 にアクセス
2. コンテナカードが表示されることを確認
3. ポートリンクがクリック可能であることを確認
4. フィルタリング機能が動作することを確認

---

## 実装順序の推奨

1. **タスク1.1** → **タスク1.2** - 環境構築
2. **タスク2.1** → **タスク2.2** - バックエンド実装
3. **タスク3.1** → **タスク3.2** → **タスク3.3** - フロントエンド実装
4. **タスク4.1** - スタイリング
5. **タスク5.1** → **タスク5.2** - Docker設定
6. **タスク6.1** → **タスク6.2** - テスト

---

## 注意事項

### セキュリティ
- Docker socketは読み取り専用（:ro）でマウント
- 本番環境では認証レイヤーの検討が必要

### 開発時のヒント
- `bun dev`で開発サーバー起動（HMR有効）
- DockerデスクトップなどでDockerが動作している必要がある
- ホストのDocker socketにアクセス可能である必要がある

### 既存コードとの関係
- `src/APITester.tsx`は不要になる可能性あり（削除 or 置き換え）
- `src/index.ts`の既存の/api/helloは残しても良い（テスト用）
