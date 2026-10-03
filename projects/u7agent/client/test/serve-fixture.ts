/**
 * サービスの状態表示 (トップバー) のテスト用フィクスチャ。バーを描くテストが
 * `serve: serveProps()` を渡せるようにし、状態ごとの値はここで組む。
 */
import type { ServedAppProps } from "../src/components/ServedAppStatus";
import type { ServeStatus } from "../src/types";

export function serveStatus(overrides: Partial<ServeStatus> = {}): ServeStatus {
  return {
    reachable: false,
    owner: { kind: "none" },
    generation: null,
    command: { cwd: "projects/foo", command: "pnpm dev" },
    secretGeneration: null,
    ...overrides,
  };
}

export function serveProps(overrides: Partial<ServedAppProps> = {}): ServedAppProps {
  return {
    port: 8016,
    status: serveStatus(),
    failed: false,
    starting: false,
    error: undefined,
    onStart: () => {},
    onStop: () => {},
    onCancel: () => {},
    ...overrides,
  };
}
