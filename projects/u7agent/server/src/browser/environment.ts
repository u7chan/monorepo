/**
 * ブラウザの同梱先を決める。Playwright はモジュールの読み込み時に `PLAYWRIGHT_BROWSERS_PATH` から
 * registry の位置を確定するため、`playwright-core` を import する前に既定を環境変数へ入れておく必要がある
 * (session.ts の import 順序が実行時に効く)。明示された値は上書きしない (dev のキャッシュと検証用の差し替え)。
 */

export const DEFAULT_BROWSERS_PATH = "/ms-playwright";

/** 環境変数を優先し、未設定ならイメージの同梱先を使う */
export function resolveBrowsersPath(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  return value && value !== "0" ? value : DEFAULT_BROWSERS_PATH;
}

process.env.PLAYWRIGHT_BROWSERS_PATH = resolveBrowsersPath();
