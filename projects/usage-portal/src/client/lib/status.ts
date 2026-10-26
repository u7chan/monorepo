export type StatusTone = "success" | "attention" | "neutral";

export type ProviderStatus = {
  label: string;
  tone: StatusTone;
  /** 色だけで区別しないための記号。状態ラベルの先頭に置く。 */
  symbol: string;
};

/** pi-console と同じ 80%。ここを超えたら「残りわずか」として注意表示にする。 */
export const ATTENTION_THRESHOLD = 80;

export type StatusInput = {
  /** account の uuid ではなく provider で分岐する。0 件のときに opencode の行は作られない。 */
  provider: "codex" | "opencode-go";
  state: "loading" | "ok" | "stale" | "error";
  errorCode: string | null;
  limitReached: boolean;
  usedPercents: number[];
};

export function deriveProviderStatus(input: StatusInput): ProviderStatus {
  if (input.errorCode === "not_connected") {
    return { label: "未接続", tone: "neutral", symbol: "○" };
  }

  if (input.provider === "codex" && input.errorCode === "reauth_required") {
    return { label: "再サインイン", tone: "attention", symbol: "▲" };
  }

  switch (input.state) {
    case "loading":
      return { label: "取得中", tone: "neutral", symbol: "○" };
    case "error":
      return { label: "取得エラー", tone: "attention", symbol: "■" };
    case "stale":
      return { label: "更新停止", tone: "attention", symbol: "▲" };
    default:
      break;
  }

  if (input.limitReached || input.usedPercents.some((percent) => percent >= 100)) {
    return { label: "上限到達", tone: "attention", symbol: "▲" };
  }

  if (input.usedPercents.some((percent) => percent >= ATTENTION_THRESHOLD)) {
    return { label: "残りわずか", tone: "attention", symbol: "▲" };
  }

  return { label: "利用可能", tone: "success", symbol: "●" };
}

/** 取得に失敗している provider でも、前回値があるときは数値を残す。 */
export function showsWindows(state: StatusInput["state"]): boolean {
  return state === "ok" || state === "stale";
}
