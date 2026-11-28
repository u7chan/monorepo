/**
 * サービスの状態表示 (トップバー) のテスト用フィクスチャ。バーを描くテストが
 * `serve: serveProps()` を渡せるようにし、状態ごとの値はここで組む。
 */
import type { ServedAppProps } from "../src/components/ServedAppStatus";
import {
  INITIAL_SERVE_TUNNEL_STATE,
  serveTunnelView,
  type ServeTunnelEntry,
  type ServeTunnelState,
} from "../src/lib/serveTunnel";
import type { ServeTunnelStatus } from "../src/types";
import type { ServeStatus } from "../src/types";

export const TUNNEL_NOW = 1_000_000;

export function tunnelStatus(overrides: Partial<ServeTunnelStatus> = {}): ServeTunnelStatus {
  return {
    available: true,
    unavailableReason: null,
    state: "idle",
    provider: "cloudflare-quick",
    active: null,
    lastEnded: null,
    ...overrides,
  };
}

/** 共有中 (`active`)。期限は `TUNNEL_NOW` の 52 分後 */
export function activeTunnelStatus(overrides: Partial<ServeTunnelStatus> = {}): ServeTunnelStatus {
  return tunnelStatus({
    state: "active",
    active: {
      url: "https://quiet-example-demo.trycloudflare.com",
      startedAt: TUNNEL_NOW - 8 * 60_000,
      expiresAt: TUNNEL_NOW + 52 * 60_000,
      target: { title: "トップページの改修", cwd: "projects/foo", command: "pnpm dev" },
    },
    ...overrides,
  });
}

export function tunnelState(overrides: Partial<ServeTunnelState> = {}): ServeTunnelState {
  const known = overrides.known === undefined ? tunnelStatus() : overrides.known;
  return {
    ...INITIAL_SERVE_TUNNEL_STATE,
    loading: false,
    status: known,
    known,
    observedAt: TUNNEL_NOW,
    ...overrides,
  };
}

export function tunnelEntry(overrides: Partial<ServeTunnelEntry> & { state?: Partial<ServeTunnelState> } = {}) {
  const { state, ...rest } = overrides;
  const entry: ServeTunnelEntry = {
    view: serveTunnelView(tunnelState(state)),
    notice: null,
    stopping: false,
    error: undefined,
    onOpen: () => {},
    onStop: () => {},
    onDismissNotice: () => {},
    ...rest,
  };
  return entry;
}

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
    tunnel: tunnelEntry(),
    failed: false,
    starting: false,
    error: undefined,
    row: { episode: false },
    onOpenRow: () => {},
    onDismissRow: () => {},
    focusRequest: false,
    onFocusHandled: () => {},
    onStart: () => {},
    onStop: () => {},
    onCancel: () => {},
    ...overrides,
  };
}
