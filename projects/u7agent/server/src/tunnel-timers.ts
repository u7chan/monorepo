/** 期限と確認待ちの猶予を、テストで決まった時刻に進めるための差し替え口 */
export interface TunnelTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** unref で、短命なタイマーが BFF の終了を待たせないようにする */
export const systemTunnelTimers: TunnelTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
