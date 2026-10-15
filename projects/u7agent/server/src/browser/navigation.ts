/**
 * 標準経路の遷移。開始前にポリシー違反を落とし、遷移後は最終 URL がループバックのままか確かめる。
 * proxy の 403 は `goto` の失敗にならないため、redirect で外へ出た結果をそのまま成果物にしない
 * (docs/browser.md#外部到達の境界)。
 */
import type { Page, Response } from "playwright-core";
import { NAVIGATION_TIMEOUT_MS } from "./limits";
import { isAllowedUrl } from "./policy";

export class ReachDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReachDeniedError";
  }
}

/** 外部到達の拒否。`shot` / `dom` は入力エラー、`check` は検証失敗として扱う */
export function assertAllowedUrl(url: string): void {
  if (isAllowedUrl(url)) return;
  throw new ReachDeniedError(`ループバック以外へは通信しません: ${url}`);
}

export interface NavigateOptions {
  timeoutMs?: number;
}

/** 遷移して load を待つ。失敗はそのまま投げ、呼び出し元が分類する */
export async function navigate(page: Page, url: string, options: NavigateOptions = {}): Promise<Response | null> {
  assertAllowedUrl(url);
  const response = await page.goto(url, { timeout: options.timeoutMs ?? NAVIGATION_TIMEOUT_MS });
  if (!isAllowedUrl(page.url())) throw new ReachDeniedError(`外部へ redirect されました: ${page.url()}`);
  return response;
}
