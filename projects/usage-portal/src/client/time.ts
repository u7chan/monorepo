const DAY_MS = 24 * 60 * 60 * 1000;

/** 期限の 3 日前から再ログインを促す。 */
export const EXPIRY_NOTICE_MS = 3 * DAY_MS;

export function lockSecondsLeft(lockedUntil: number, now: number): number {
  return Math.max(0, Math.ceil((lockedUntil - now) / 1000));
}

/** 3 日以内に期限が来るときだけ残り日数を返す。期限切れと余裕のある状態は null。 */
export function expiryDaysLeft(expiresAt: number, now: number): number | null {
  const remaining = expiresAt - now;

  if (remaining <= 0 || remaining > EXPIRY_NOTICE_MS) {
    return null;
  }

  return Math.ceil(remaining / DAY_MS);
}

export function describeWait(seconds: number): string {
  return seconds >= 60 ? `${Math.ceil(seconds / 60)} 分` : `${seconds} 秒`;
}
