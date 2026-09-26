/**
 * 設定 → ランタイムの実行環境カードの表示変換と、health / モデルカタログ / 実行環境をまとめて
 * 取り直す手順。コンポーネントから切り出して、状態の分岐と古い応答の扱いをテストできるようにする。
 */
import type {
  Health,
  RuntimeEnvironmentResponse,
  RuntimeEnvironmentState,
  RuntimeModelsResponse,
  SandboxRuntimeCommand,
} from "../types";

export type RuntimeEnvironmentSummary = {
  label: string;
  detail: string;
  tone: "ok" | "muted" | "danger";
};

/** 状態コードごとの表示。生のエラー文言は出さず、原因の分類と確認先だけを示す。 */
export function runtimeEnvironmentSummary(state: RuntimeEnvironmentState): RuntimeEnvironmentSummary {
  switch (state) {
    case "connected":
      return {
        label: "接続中",
        detail: "認証付きの診断 API が正常に応答しました。ツール実行の成功を保証するものではありません。",
        tone: "ok",
      };
    case "not_configured":
      return {
        label: "未設定",
        detail: "BFF にサンドボックスの接続情報がありません (PI_SANDBOX_URL / PI_SANDBOX_TOKEN)。",
        tone: "muted",
      };
    case "unreachable":
      return { label: "到達できません", detail: "サンドボックスへ接続できませんでした。", tone: "danger" };
    case "unauthorized":
      return {
        label: "認証失敗",
        detail: "サンドボックスの認証に失敗しました (PI_SANDBOX_TOKEN を確認してください)。",
        tone: "danger",
      };
    case "timeout":
      return { label: "応答なし", detail: "サンドボックスの診断が期限内に応答しませんでした。", tone: "danger" };
    case "probe_failed":
      return { label: "診断に失敗", detail: "実行環境の情報を取得できませんでした。", tone: "danger" };
  }
}

export type RuntimeCommandRow = { key: string; name: string; version: string };

/** 検出できたコマンドだけを行にする。バージョンを取れなかったものは「バージョン不明」として残す。 */
export function runtimeCommandRows(commands: readonly SandboxRuntimeCommand[]): RuntimeCommandRow[] {
  return commands.map((command, index) => ({
    key: `${index}-${command.name}`,
    name: command.name,
    version: command.version ?? "バージョン不明",
  }));
}

export type RuntimeReloadOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

export type RuntimeReloadResults = {
  /** includeHealth が false のときは null (親が持つ health をそのまま使う) */
  health: RuntimeReloadOutcome<Health> | null;
  models: RuntimeReloadOutcome<RuntimeModelsResponse>;
  environment: RuntimeReloadOutcome<RuntimeEnvironmentResponse>;
};

/** 再読み込み時の health 失敗の文言。null は失敗として扱い、前回値の表示であることを明示する。 */
export const HEALTH_RELOAD_FAILED_MESSAGE = "接続状態を再取得できませんでした。前回の値を表示しています。";

export type RuntimeReloadInput = {
  includeHealth: boolean;
  /**
   * この取得が最新かの判定。親の `refreshHealth` へそのまま渡し、アンマウント後 / 新しい取得後の
   * health 応答を親の state へ適用させない (画面内の state だけでは親の上書きを防げない)。
   */
  isCurrent: () => boolean;
  /** 既存の契約 (失敗もキャンセルも null) は変えず、ここで明示的な失敗へ変換する */
  refreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>;
  getModels: () => Promise<RuntimeModelsResponse>;
  getEnvironment: () => Promise<RuntimeEnvironmentResponse>;
};

/**
 * 3 系統をまとめて取得する。1 系統の失敗で他を捨てず、全 settled を待つ。
 * 古い応答を適用しない判定は呼び出し側 (createRuntimeReloadGate) が持つ。
 */
export async function reloadRuntime(input: RuntimeReloadInput): Promise<RuntimeReloadResults> {
  if (!input.includeHealth) {
    const [models, environment] = await Promise.allSettled([input.getModels(), input.getEnvironment()]);
    return { health: null, models: outcomeOf(models), environment: outcomeOf(environment) };
  }
  const [health, models, environment] = await Promise.allSettled([
    refreshHealthOrFail(input.refreshHealth, input.isCurrent),
    input.getModels(),
    input.getEnvironment(),
  ]);
  return { health: outcomeOf(health), models: outcomeOf(models), environment: outcomeOf(environment) };
}

async function refreshHealthOrFail(
  refreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>,
  isCurrent: () => boolean,
): Promise<Health> {
  const value = await refreshHealth(isCurrent);
  if (value === null) throw new Error(HEALTH_RELOAD_FAILED_MESSAGE);
  return value;
}

function outcomeOf<T>(result: PromiseSettledResult<T>): RuntimeReloadOutcome<T> {
  if (result.status === "fulfilled") return { ok: true, value: result.value };
  return { ok: false, message: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}

export type RuntimeFetchState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

export function runtimeFetchStateOf<T>(outcome: RuntimeReloadOutcome<T>): RuntimeFetchState<T> {
  return outcome.ok ? { status: "ready", value: outcome.value } : { status: "error", message: outcome.message };
}

export type RuntimeReloadGate = {
  /** 取得を開始する。返る isCurrent が false の応答は適用しない */
  begin: () => () => boolean;
  /** アンマウントなどで進行中の応答を捨てる */
  invalidate: () => void;
};

/** 後から始めた取得だけを適用する世代番号。再試行とアンマウントの両方をここで判定する。 */
export function createRuntimeReloadGate(): RuntimeReloadGate {
  let generation = 0;
  return {
    begin: () => {
      const current = (generation += 1);
      return () => current === generation;
    },
    invalidate: () => {
      generation += 1;
    },
  };
}
