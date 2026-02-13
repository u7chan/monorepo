import type { Container } from "../types/container";

// 各種状態のコンテナデータ
export const mockContainers: Container[] = [
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
export function generateManyContainers(count: number): Container[] {
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

// 環境変数チェック用関数
export function isMockMode(): boolean {
  return process.env.USE_MOCK_DATA === "true";
}
