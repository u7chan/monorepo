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
