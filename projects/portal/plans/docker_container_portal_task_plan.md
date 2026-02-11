# Docker Container Portal タスクプラン

## 概要
Bun.serve() + React + TypeScriptでDocker Container Portalを構築する最初のタスクプラン。

## 前提条件
- 現在のプロジェクト構成: `bun init`生成のBun + React構成
- バックエンド: Bun.serve()（Expressは使用しない）
- フロントエンド: React + TypeScript + Tailwind CSS
- Docker連携: Bunの `$` テンプレートリテラル（`docker ps` コマンド実行）

---

## Phase 1: 環境構築と依存関係

### タスク1.1: 型定義の準備
**目的**: Dockerコンテナ情報の型を定義
- Container型の定義（Ports, Names, Image, Stateなど）
- APIレスポンス型の定義

**成果物**:
- `src/types/container.ts` - コンテナ関連の型定義

---

## Phase 2: バックエンド実装

### タスク2.1: Docker CLIサービスの作成
**目的**: Bunの `$` を使って `docker ps` コマンドを実行しコンテナ情報を取得

**実装内容**:
- Bun.$ を使って `docker ps --format json` を実行
- JSON出力をパースして型付け
- ポート情報のパース処理（`0.0.0.0:4000->4000/tcp` 形式）
- エラーハンドリング

**成果物**:
- `src/services/docker.ts` - Docker CLIラッパーサービス

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

## Phase 6: バックエンドロジックテスト（`bun test`）

Bun組み込みの`bun:test`を使用し、Docker CLI出力のパース処理など純粋なロジックのみを単体テストします。APIエンドポイントのHTTPテストやCI設定は含めません。

---

### タスク6.1: Dockerサービスのユニットテスト

**目的**: `Bun.$`をモック化し、コンテナ情報のパース・変換ロジックのみを検証

**テスト対象**: `src/services/docker.test.ts`
- `docker ps --format json` のJSONパース処理
- ポート文字列（`0.0.0.0:4000->4000/tcp`）の正規表現による分解
- コンテナ名の正規化（先頭の`/`除去）
- 状態に応じたフィルタリングロジック（実行中/停止中の分類）

**実装方針**:
```typescript
import { test, expect, mock } from "bun:test";
import { parseContainers, fetchContainers } from "./docker";

// Bun.$ のモック（シェルコマンドを実際に実行しない）
mock.module("bun", () => ({
  $: mock(async () => ({
    json: async () => [
      {
        Names: "/my-app",
        State: "running",
        Status: "Up 2 hours",
        Image: "nginx:latest",
        Ports: "0.0.0.0:3000->80/tcp, 0.0.0.0:4000->443/tcp",
        Id: "abc123"
      },
      {
        Names: "/stopped-app",
        State: "exited",
        Status: "Exited (0) 3 hours ago",
        Image: "redis:latest",
        Ports: "",
        Id: "def456"
      }
    ]
  }))
}));

test("ポート文字列を正しくパースする", () => {
  const raw = "0.0.0.0:3000->80/tcp, 0.0.0.0:4000->443/tcp";
  const result = parsePorts(raw);
  
  expect(result).toEqual([
    { host: "0.0.0.0", publicPort: 3000, privatePort: 80, protocol: "tcp" },
    { host: "0.0.0.0", publicPort: 4000, privatePort: 443, protocol: "tcp" }
  ]);
});

test("コンテナ名から先頭のスラッシュを除去する", async () => {
  const containers = await fetchContainers();
  expect(containers[0].name).toBe("my-app"); // "/my-app" -> "my-app"
});

test("ポートが空文字の場合は空配列を返す", () => {
  const result = parsePorts("");
  expect(result).toEqual([]);
});
```

**成果物**:
- `src/services/docker.test.ts`（`docker.ts`と同じディレクトリに配置）

---

## 実行コマンド

```bash
# テスト実行
bun test

# ウォッチモード（ファイル保存時に自動実行）
bun test --watch
```
