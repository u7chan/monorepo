/** 管理 API の入力不正。HTTP の status と、画面が文言へ変換する code を持つ。 */
export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** u7agent → 中継の応答不正。上流の状態をそのまま返さず、中継側の code に丸める。 */
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
