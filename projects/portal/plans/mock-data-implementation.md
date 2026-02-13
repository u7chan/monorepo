# モックデータ対応実装プラン

## 概要

本番環境でレイアウトバグが発生しているが、ローカル環境でdockerコマンドが通らないためUI確認ができない。環境変数で切り替え可能なモックデータモードを実装し、ローカルでのレイアウト確認を可能にする。

## 現状分析

### 問題点

1. **Docker依存**: `src/services/docker.ts` で `docker ps` コマンドを直接実行
2. **ローカル開発不可**: dockerコマンドが通らない環境で開発・テスト不可
3. **レイアウトバグ確認困難**: 本番のみで発生するUI問題のデバッグが困難

### コード構成

- `src/index.ts`: Bun.serve() でAPIエンドポイント `/api/containers` を提供
- `src/services/docker.ts`: Docker CLIラッパー
- `src/components/ContainerList.tsx`: コンテナ一覧表示（APIからデータ取得）
- `src/components/ContainerCard.tsx`: 個別カードコンポーネント

## 実装内容

### 1. モックデータサービス作成

**新規ファイル: `src/services/mockData.ts`**

```typescript
// 各種状態のコンテナデータ
export const mockContainers = [
  // running状態 - Webサーバー
  {
    id: "abc123def456789",
    name: "nginx-proxy",
    image: "nginx:alpine",
    state: "running",
    status: "Up 3 days",
    ports: [
      { host: "0.0.0.0", publicPort: 80, privatePort: 80, protocol: "tcp" },
      { host: "0.0.0.0", publicPort: 443, privatePort: 443, protocol: "tcp" },
    ],
    created: "2024-01-15T10:30:00Z",
  },
  // running状態 - DB
  {
    id: "def789ghi012345",
    name: "postgres-db",
    image: "postgres:15",
    state: "running",
    status: "Up 5 hours",
    ports: [{ host: "0.0.0.0", publicPort: 5432, privatePort: 5432, protocol: "tcp" }],
    created: "2024-01-20T14:00:00Z",
  },
  // exited状態
  {
    id: "ghi012jkl345678",
    name: "redis-cache",
    image: "redis:7",
    state: "exited",
    status: "Exited (0) 2 days ago",
    ports: [],
    created: "2024-01-10T09:00:00Z",
  },
  // paused状態
  {
    id: "jkl345mno678901",
    name: "elasticsearch",
    image: "elasticsearch:8",
    state: "paused",
    status: "Paused",
    ports: [{ host: "0.0.0.0", publicPort: 9200, privatePort: 9200, protocol: "tcp" }],
    created: "2024-01-18T16:30:00Z",
  },
  // 長い名前
  {
    id: "mno678pqr901234",
    name: "my-project-backend-api-server-production",
    image: "mycompany/backend-api:v2.1.3-beta.4",
    state: "running",
    status: "Up 1 week",
    ports: [
      { host: "0.0.0.0", publicPort: 3000, privatePort: 3000, protocol: "tcp" },
      { host: "0.0.0.0", publicPort: 3001, privatePort: 3001, protocol: "tcp" },
    ],
    created: "2024-01-12T08:00:00Z",
  },
  // 多量ポート
  {
    id: "pqr901stu234567",
    name: "dev-environment",
    image: "ubuntu:22.04",
    state: "running",
    status: "Up 30 minutes",
    ports: [
      { host: "0.0.0.0", publicPort: 8080, privatePort: 80, protocol: "tcp" },
      { host: "0.0.0.0", publicPort: 8081, privatePort: 81, protocol: "tcp" },
      { host: "0.0.0.0", publicPort: 8082, privatePort: 82, protocol: "tcp" },
      { host: "0.0.0.0", publicPort: 8083, privatePort: 83, protocol: "tcp" },
      { host: "0.0.0.0", publicPort: 8084, privatePort: 84, protocol: "tcp" },
    ],
    created: "2024-01-21T10:00:00Z",
  },
  // restarting状態
  {
    id: "stu234vwx567890",
    name: "unstable-app",
    image: "crash-loop:latest",
    state: "restarting",
    status: "Restarting (1) 5 seconds ago",
    ports: [{ host: "0.0.0.0", publicPort: 9000, privatePort: 9000, protocol: "tcp" }],
    created: "2024-01-21T09:00:00Z",
  },
  // ポートなし
  {
    id: "vwx567yza890123",
    name: "background-worker",
    image: "worker:latest",
    state: "running",
    status: "Up 2 days",
    ports: [],
    created: "2024-01-19T12:00:00Z",
  },
];

// 大量データ生成（レイアウトテスト用）
export function generateManyContainers(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `container${String(i).padStart(12, "0")}`,
    name: `service-${i % 5 === 0 ? "very-long-service-name-for-layout-test" : `app-${i}`}`,
    image: `image${i}:latest`,
    state: i % 3 === 0 ? "running" : i % 3 === 1 ? "exited" : "paused",
    status: i % 3 === 0 ? "Up 1 hour" : i % 3 === 1 ? "Exited (0)" : "Paused",
    ports:
      i % 2 === 0
        ? [{ host: "0.0.0.0", publicPort: 8000 + i, privatePort: 80, protocol: "tcp" }]
        : [],
    created: new Date(Date.now() - i * 3600000).toISOString(),
  }));
}
```

### 2. Dockerサービスのモック対応

**修正ファイル: `src/services/docker.ts`**

```typescript
// 既存のインポートに追加
import { mockContainers, generateManyContainers } from "./mockData";

// 環境変数チェック用関数
function isMockMode(): boolean {
  return process.env.USE_MOCK_DATA === "true";
}

// fetchContainers関数を修正
export async function fetchContainers(all: boolean = false): Promise<Container[]> {
  // モックモード時はモックデータを返す
  if (isMockMode()) {
    console.log("[MOCK MODE] Returning mock container data");
    // 大量データテストが必要な場合はこちら
    // return generateManyContainers(20);
    return mockContainers;
  }

  // 既存の実装（変更なし）
  try {
    const cmd = all ? "docker ps --all --format json" : "docker ps --format json";
    // ... 残りの実装
  } catch (error) {
    // ... エラーハンドリング
  }
}
```

### 3. サーバーの環境変数対応

**修正ファイル: `src/index.ts`**

```typescript
// モックモード表示用ヘッダー追加
const isMockMode = process.env.USE_MOCK_DATA === "true";

if (isMockMode) {
  console.log("🎭 MOCK MODE ENABLED - Using mock container data");
}
```

### 4. フロントエンドにモックモード表示

**修正ファイル: `src/App.tsx`**

```typescript
// モックモードバッジをヘッダーに追加
const isMockMode = process.env.USE_MOCK_DATA === "true";

// ヘッダー部分に追加
{isMockMode && (
  <span className="ml-3 px-2 py-1 rounded text-xs font-medium bg-purple-500/20 text-purple-400 border border-purple-500/30">
    MOCK MODE
  </span>
)}
```

### 5. package.jsonにスクリプト追加

**修正ファイル: `package.json`**

```json
{
  "scripts": {
    "dev": "bun --hot src/index.ts",
    "dev:mock": "USE_MOCK_DATA=true bun --hot src/index.ts",
    "start": "NODE_ENV=production bun src/index.ts",
    "start:mock": "USE_MOCK_DATA=true NODE_ENV=production bun src/index.ts",
    "build": "bun run build.ts"
  }
}
```

## テストケース

### レイアウト確認用モックデータ

1. **通常表示**: 8個のコンテナ（各種状態）
2. **大量データ**: `generateManyContainers(20)` で20個
3. **長い名前**: `my-project-backend-api-server-production`
4. **多量ポート**: 5つのポートマッピング
5. **ポートなし**: `background-worker`

### 確認項目

- [ ] グリッドレイアウト（1/2/3/4列）が正しく動作
- [ ] 長い名前が適切にtruncateされる
- [ ] ポートリンクが正しく折り返される
- [ ] 空の状態表示が正しく動作
- [ ] エラー状態表示が正しく動作
- [ ] ローディング状態が正しく動作

## 実行手順

```bash
# モックモードで開発サーバー起動
bun run dev:mock

# または環境変数を直接指定してbun devを使用
USE_MOCK_DATA=true bun dev

# 通常モードで開発サーバー起動（Docker必要）
bun run dev

# モックモードで本番ビルド確認
bun run start:mock
```

## ファイル変更一覧

| ファイル                   | 変更内容                                    |
| -------------------------- | ------------------------------------------- |
| `src/services/mockData.ts` | 新規作成 - モックデータ定義                 |
| `src/services/docker.ts`   | 修正 - モックモード判定追加                 |
| `src/index.ts`             | 修正 - モックモードログ追加                 |
| `src/App.tsx`              | 修正 - モックモードバッジ追加（オプション） |
| `package.json`             | 修正 - スクリプト追加                       |

## レイアウトバグ調査のヒント

モックモード有効化後、以下を確認：

1. **ブラウザDevTools**: レスポンシブモードで各画面サイズを確認
2. **要素検証**: カードの高さ・幅、グリッドgap
3. **テキストtruncate**: 長い名前の表示確認
4. **ポート表示**: 多量ポート時の折り返し確認
