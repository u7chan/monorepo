export type StatusTone = "success" | "attention" | "danger" | "neutral";

/** provider のマークの色。契約が無い・切れた・枠を使い切ったときだけ灰色にする。 */
export type ProviderMarkColor = "brand" | "muted";

export type ProviderStatus = {
  label: string;
  tone: StatusTone;
  /** 色だけで区別しないための記号。状態ラベルの先頭に置く。 */
  symbol: string;
  mark: ProviderMarkColor;
};

/** pi-console と同じ 80%。ここを超えたら「残りわずか」として注意表示にする。 */
export const ATTENTION_THRESHOLD = 80;

export type StatusInput = {
  /** account の uuid ではなく provider で分岐する。0 件のときに opencode の行は作られない。 */
  provider: "codex" | "opencode-go" | "claude" | "gemini";
  state: "loading" | "ok" | "stale" | "error";
  errorCode: string | null;
  limitReached: boolean;
  usedPercents: number[];
};

export function deriveProviderStatus(input: StatusInput): ProviderStatus {
  if (input.errorCode === "not_connected") {
    return { label: "未接続", tone: "neutral", symbol: "○", mark: "muted" };
  }

  // 更新停止に含めると、待てば自動で戻るように読める。契約を直すまで戻らないため分ける。
  if (input.provider !== "codex" && input.errorCode === "subscription_required") {
    return { label: "契約エラー", tone: "attention", symbol: "■", mark: "muted" };
  }

  // 再サインインは契約ではなくセッションの失効なので、マークの色は残す。
  if (input.provider !== "opencode-go" && input.errorCode === "reauth_required") {
    return { label: "再サインイン", tone: "attention", symbol: "▲", mark: "brand" };
  }

  switch (input.state) {
    case "loading":
      return { label: "取得中", tone: "neutral", symbol: "○", mark: "brand" };
    case "error":
      return { label: "取得エラー", tone: "attention", symbol: "■", mark: "brand" };
    case "stale":
      return { label: "更新停止", tone: "attention", symbol: "▲", mark: "brand" };
    default:
      break;
  }

  if (input.limitReached || input.usedPercents.some((percent) => percent >= 100)) {
    return { label: "上限到達", tone: "attention", symbol: "▲", mark: "muted" };
  }

  if (input.usedPercents.some((percent) => percent >= ATTENTION_THRESHOLD)) {
    return { label: "残りわずか", tone: "attention", symbol: "▲", mark: "brand" };
  }

  return { label: "利用可能", tone: "success", symbol: "●", mark: "brand" };
}

/** 取得に失敗している provider でも、前回値があるときは数値を残す。 */
export function showsWindows(state: StatusInput["state"]): boolean {
  return state === "ok" || state === "stale";
}
