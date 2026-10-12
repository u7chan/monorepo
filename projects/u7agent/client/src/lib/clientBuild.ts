/**
 * 診断のスナップショットへ載せるクライアントのビルド識別子。Vite の define (`__U7AGENT_BUILD__`) が
 * ビルド時に埋め、Vite の外 (テスト / tsc) では unknown になる。
 */
export function clientBuildId(): string {
  return typeof __U7AGENT_BUILD__ === "string" && __U7AGENT_BUILD__ !== "" ? __U7AGENT_BUILD__ : "unknown";
}
