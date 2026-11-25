/**
 * 版ずれの案内の判定と文言。client と BFF が同じイメージから配られたかは、ビルド時に埋めた識別子と
 * `GET /api/health` の `buildId` だけを比べて決める (docs/architecture.md の「版の互換の範囲」)。
 * SSE の `eventGeneration` は BFF の再起動でも変わるので、版の識別には使わない。
 */

/** 案内の文言。画面と SSR のテストが同じ定数を読む */
export const VERSION_MISMATCH_NOTICE = {
  heading: "アプリとサーバーの版が一致しません",
  detail:
    "表示中のアプリは、いまのサーバーとは別の版で動いています。再読み込みすると、サーバーが配る版でアプリを読み直します。再読み込みしても直らないときは、サーバー側（BFF）も同じ版へ更新してください。",
  action: "再読み込み",
} as const;

/**
 * client の版の識別子。ビルド時は Vite の define (`__U7AGENT_BUILD_ID__`) が埋め、
 * dev サーバーでは未定義 = 空文字 (案内を出さない)。dev でも fixture が差し替えられるよう、
 * 実行時の `VITE_U7AGENT_BUILD_ID` を先に読む。
 */
export function clientBuildId(): string {
  const explicit = import.meta.env?.VITE_U7AGENT_BUILD_ID;
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  return typeof __U7AGENT_BUILD_ID__ === "string" ? __U7AGENT_BUILD_ID__.trim() : "";
}

/**
 * 版ずれの判定。識別子が取れない (dev サーバー / ビルド外 / 旧サーバーで health に無い)、
 * 取得に失敗した (null / undefined) ときは出さない。誤検知で再読み込みを促すほうが害が大きい。
 */
export function versionMismatchOf(clientId: string, serverId: string | null | undefined): boolean {
  const client = clientId.trim();
  const server = (serverId ?? "").trim();
  if (!client || !server) return false;
  return client !== server;
}

export type VersionMismatchTracker = {
  /** health を受けるたびに呼ぶ。一度でも版ずれを見たら、その画面では true を保つ */
  check: (serverId: string | null | undefined) => boolean;
};

/**
 * 画面 1 つ分の判定の保持。App はスペース切替で作り直されるため、判定を App の state にだけ置くと
 * 案内が消えて出し直しになる。一度出したら再読み込みするまで保つ。
 */
export function createVersionMismatchTracker(clientId: string): VersionMismatchTracker {
  let detected = false;
  return {
    check: (serverId) => {
      if (!detected) detected = versionMismatchOf(clientId, serverId);
      return detected;
    },
  };
}
