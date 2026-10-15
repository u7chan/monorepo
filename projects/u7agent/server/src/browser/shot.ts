/**
 * `shot` の本体。cwd へ残すのは明示された画像 1 枚だけで、Playwright が自動で作るもの
 * (プロファイル / ログ / snapshot) は呼び出しごとの一時領域に閉じる (session.ts が TMPDIR を差し替える)。
 */
import { MAX_IMAGE_BYTES, READY_TIMEOUT_MS } from "./limits";
import { navigate } from "./navigation";
import { saveOutput, type SavedOutput } from "./outputs";
import type { BrowserSession } from "./session";

export interface ShotOptions {
  fullPage?: boolean;
  waitForSelector?: string;
  waitForTimeoutMs?: number;
  navigationTimeoutMs?: number;
  waitTimeoutMs?: number;
  /** 保存先の基準。既定は呼び出し元の cwd (入口が chdir しないので、そのまま成果物の置き場になる) */
  cwd?: string;
}

export async function runShot(
  session: BrowserSession,
  url: string,
  out: string,
  options: ShotOptions = {},
): Promise<SavedOutput> {
  await navigate(session.page, url, { timeoutMs: options.navigationTimeoutMs });
  if (options.waitForSelector) {
    await session.page.waitForSelector(options.waitForSelector, { timeout: options.waitTimeoutMs ?? READY_TIMEOUT_MS });
  }
  if (options.waitForTimeoutMs) await session.page.waitForTimeout(options.waitForTimeoutMs);
  // 画面全体が上限を超える場合があるため、保存の前にバイト数で止める
  const image = await session.page.screenshot({ fullPage: options.fullPage ?? false, type: "png" });
  if (image.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`画像が上限 (${MAX_IMAGE_BYTES} bytes) を超えました: ${image.byteLength} bytes`);
  }
  return saveOutput(options.cwd ?? process.cwd(), out, image);
}
