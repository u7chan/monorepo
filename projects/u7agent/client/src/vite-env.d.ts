/// <reference types="vite/client" />

/** Vite の define が埋めるビルド識別子。Vite の外 (テスト / tsc) では未定義になる */
declare const __U7AGENT_BUILD__: string | undefined;

/**
 * UI を増やさない診断の入口。コピーと同じ文字列を返すだけにして、画面には出さない
 * (docs/diagnostics.md)。
 */
interface Window {
  u7agentDebug?: { snapshot: () => Promise<string> };
}
