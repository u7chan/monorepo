// Docker Container Portal - 型定義

/**
 * ポート情報の型
 * Dockerのポートマッピング "0.0.0.0:3000->80/tcp" をパースした結果
 */
export interface PortMapping {
  host: string;
  publicPort: number;
  privatePort: number;
  protocol: string;
}

/**
 * コンテナ情報の型
 */
export interface Container {
  id: string;
  name: string;
  image: string;
  state: "running" | "exited" | "paused" | "restarting" | "removing" | "dead";
  status: string;
  ports: PortMapping[];
  created?: string;
  command?: string;
  // 公開ポート -> ラベルで上書きされた URL
  urls?: Record<number, string>;
  // 単一の入口（portal.url）。あるとポートのタイルを出さない
  url?: string;
  // インフラ用でリンクを出さない（portal.hidden）
  hidden?: boolean;
  // デプロイ対象の compose project。monorepo の GHCR イメージの主コンテナだけ入る
  deployTarget?: string;
  // portal からイメージタグを切り替えられるか
  canDeploy?: boolean;
}

/**
 * イメージタグの選択肢
 */
export interface ImageTagOption {
  tag: string;
  createdAt?: string;
}

/**
 * 稼働中のイメージより新しいビルドがあるコンテナ
 */
export interface ImageUpdate {
  containerId: string;
  /** 最新ビルドの代表タグ (同じビルドの sha-* / manual-* のうち 1 つ) */
  latestTag: string;
  /** 最新ビルドの作成日時 (GHCR の created_at) */
  createdAt?: string;
}

/**
 * デプロイ可能なタグ一覧のレスポンス
 */
export interface DeployOptionsResponse {
  target: string;
  currentTag: string | null;
  tags: ImageTagOption[];
}

/**
 * デプロイ起動のレスポンス
 */
export interface DeployResponse {
  target: string;
  tag: string;
  workflowUrl: string;
}

/**
 * Docker CLI JSON出力の生データ型
 */
export interface DockerContainerRaw {
  ID?: string;
  Id?: string;
  Names?: string;
  Image?: string;
  State?: string;
  Status?: string;
  Ports?: string;
  CreatedAt?: string;
  Command?: string;
  Labels?: string;
}

/**
 * APIレスポンス型
 */
export interface ContainersResponse {
  containers: Container[];
  count: number;
  timestamp: string;
}

/**
 * フィルタータイプ
 */
export type ContainerFilter = "all" | "running" | "stopped";
