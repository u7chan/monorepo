/**
 * 設定 → ランタイムの表示変換（行の値・状態文言・一括コピー本文）と、health / 実行環境を
 * まとめて取り直す手順。コンポーネントから切り出して、状態の分岐と古い応答の扱いをテストできるようにする。
 */
import type {
  Health,
  RuntimeEnvironmentResponse,
  RuntimeEnvironmentState,
  SandboxLandlockStatus,
  SandboxRuntimeCommand,
  SandboxRuntimeEnvironment,
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

// 以下は画面の行とコピー本文。行ビルダーと文言を画面側と共有しないと、片方だけ直したときに
// コピーした内容が画面と食い違う (貼った先の AI には、その食い違いに気づく手段がない)。

/** セクション見出し */
export const RUNTIME_SECTION_TITLES = {
  connection: "接続状態",
  environment: "実行環境（サンドボックス側）",
  commands: "利用可能なコマンド",
} as const;

/** 既定モデルの注記。実効モデルと取り違えられると診断が誤るため、表示とコピーの両方へ出す */
const RUNTIME_DEFAULT_MODEL_NOTE = "アプリの既定モデルです。会話中に使われている実効モデルではありません。";
const RUNTIME_ROOT_USER_NOTE = "root で動いています。コンテナ外への影響を避けるため、非 root 実行を推奨します。";

/** 実行環境カードの状態文言 */
export const RUNTIME_ENVIRONMENT_LOADING = "実行環境を取得しています。";
export const RUNTIME_ENVIRONMENT_ERROR_LEAD = "実行環境を取得できませんでした。";

/** コマンドカードの状態文言 */
export const RUNTIME_COMMANDS_LOADING = "コマンドを検出しています。";
export const RUNTIME_COMMANDS_UNAVAILABLE = "実行環境の情報を取得できていないため、コマンドは表示していません。";
export const RUNTIME_COMMANDS_EMPTY = "検出できたコマンドはありません。";
export const RUNTIME_COMMANDS_FOOTNOTE = "実際に検出できたコマンドだけを表示します。";

export type RuntimeTone = RuntimeEnvironmentSummary["tone"];

/** 画面 1 行分の値。コピー本文もこの値をそのまま使う */
export type RuntimeInfoRow = { label: string; value: string; note?: string };

/** 状態ドットを持つ行 (実行環境の接続状態だけ) */
export type RuntimeStatusRow = RuntimeInfoRow & { tone: RuntimeTone };

/** 接続状態カードの行。health が無いときも「情報なし」で行を残す (欠落を空欄で隠さない) */
export function runtimeConnectionRows(health: Health | null): RuntimeInfoRow[] {
  return [
    { label: "ランタイム", value: health ? (health.ready ? "利用可能" : "利用できません") : "情報なし" },
    { label: "サンドボックス", value: health ? (health.sandboxConfigured ? "設定済み" : "未設定") : "情報なし" },
    { label: "既定モデル", value: health?.model ?? "指定なし", note: RUNTIME_DEFAULT_MODEL_NOTE },
    { label: "作業ディレクトリ (cwd)", value: health?.cwd ?? "情報なし" },
    { label: "セッションストア", value: runtimeStoreStatus(health?.sessionStore) },
    { label: "アプリ DB", value: runtimeAppDbStatus(health?.appDb) },
  ];
}

/** 接続状態カードの下に出す SDK バージョン。値が無い行は画面と同じく出さない */
export function runtimeVersionRows(health: Health | null): RuntimeInfoRow[] {
  const versions = health?.versions;
  const rows: RuntimeInfoRow[] = [{ label: "pi-coding-agent", value: versions?.piCodingAgent ?? "情報なし" }];
  if (versions?.piAi) rows.push({ label: "pi-ai", value: versions.piAi });
  if (versions?.commitHash) rows.push({ label: "COMMIT_HASH", value: versions.commitHash });
  return rows;
}

/** 実行環境カードの接続状態行。connected 以外は理由 (detail) を注記として出す */
export function runtimeEnvironmentStatusRow(state: RuntimeEnvironmentState): RuntimeStatusRow {
  const summary = runtimeEnvironmentSummary(state);
  return {
    label: "接続状態",
    value: summary.label,
    note: state === "connected" ? undefined : summary.detail,
    tone: summary.tone,
  };
}

/** connected のときに出す実行環境の行 */
export function runtimeEnvironmentRows(
  environment: SandboxRuntimeEnvironment,
  landlock: SandboxLandlockStatus,
): RuntimeInfoRow[] {
  return [
    { label: "OS", value: environment.os },
    { label: "アーキテクチャ", value: environment.arch },
    {
      label: "実行ユーザー",
      value: `${environment.user}（${environment.isRoot ? "root" : "非 root"}）`,
      note: environment.isRoot ? RUNTIME_ROOT_USER_NOTE : undefined,
    },
    { label: "ワークスペース", value: environment.workspace },
    runtimeLandlockRow(landlock),
  ];
}

/** Landlock の状態行。ABI と適用可否だけを出し、ラッパーのパスや内部エラーは出さない */
export function runtimeLandlockRow(landlock: SandboxLandlockStatus): RuntimeInfoRow {
  if (landlock.state === "enabled") {
    return {
      label: "Landlock",
      value: `有効（ABI ${landlock.abi ?? "不明"}）`,
      note: "bash の作成・書き込み・削除は許可 root の外で EACCES になります。",
    };
  }
  return {
    label: "Landlock",
    value: "利用不可",
    note: `${runtimeLandlockReason(landlock)}。bash は実行できません。`,
  };
}

function runtimeLandlockReason(landlock: SandboxLandlockStatus): string {
  switch (landlock.reason) {
    case "wrapper_missing":
      return "ラッパーが見つかりません（pnpm dev が配置します）";
    case "unsupported":
      return "カーネルが Landlock に対応していません（Linux 6.2 以上が必要です）";
    case "abi_unsupported":
      return `ABI ${landlock.abi ?? "不明"} は ${landlock.minAbi} 未満です（Linux 6.2 以上が必要です）`;
    default:
      return "診断に失敗しました";
  }
}

export function runtimeStoreStatus(store: Health["sessionStore"]): string {
  if (!store) return "情報なし";
  return `${store.ok ? "利用可能" : "利用できません"} · ${store.path ?? "永続化なし"}`;
}

export function runtimeAppDbStatus(db: Health["appDb"]): string {
  if (!db) return "情報なし";
  return `${db.ok ? "利用可能" : "利用できません"} · ${db.path ?? "永続化なし"}`;
}

export type RuntimeReloadOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

export type RuntimeReloadResults = {
  /** includeHealth が false のときは null (親が持つ health をそのまま使う) */
  health: RuntimeReloadOutcome<Health> | null;
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
  getEnvironment: () => Promise<RuntimeEnvironmentResponse>;
};

/**
 * health と実行環境をまとめて取得する。1 系統の失敗で他を捨てず、全 settled を待つ。
 * 古い応答を適用しない判定は呼び出し側 (createRuntimeReloadGate) が持つ。
 */
export async function reloadRuntime(input: RuntimeReloadInput): Promise<RuntimeReloadResults> {
  if (!input.includeHealth) {
    const [environment] = await Promise.allSettled([input.getEnvironment()]);
    return { health: null, environment: outcomeOf(environment) };
  }
  const [health, environment] = await Promise.allSettled([
    refreshHealthOrFail(input.refreshHealth, input.isCurrent),
    input.getEnvironment(),
  ]);
  return { health: outcomeOf(health), environment: outcomeOf(environment) };
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

export type RuntimeDiagnosticInput = {
  health: Health | null;
  /** health の再取得に失敗し、前回値の表示になっているか */
  healthFailed: boolean;
  environment: RuntimeFetchState<RuntimeEnvironmentResponse>;
};

/** コピー本文の見出し。どのアプリの何の情報かを、貼った先の AI が単体で判断できるようにする */
const RUNTIME_DIAGNOSTIC_TITLE = "# u7agent ランタイム診断";

/**
 * 一括コピー用の診断テキスト。値は画面と同じ行ビルダーから取り、表示とのずれを作らない。
 * 取得できていないセクションも状態文言を出す (黙って省くと、貼った先では正常な環境に見える)。
 */
export function runtimeDiagnosticText(input: RuntimeDiagnosticInput): string {
  return [
    RUNTIME_DIAGNOSTIC_TITLE,
    "",
    ...sectionLines(RUNTIME_SECTION_TITLES.connection, connectionLines(input.health, input.healthFailed)),
    "",
    ...sectionLines(RUNTIME_SECTION_TITLES.environment, environmentLines(input.environment)),
    "",
    ...sectionLines(RUNTIME_SECTION_TITLES.commands, commandLines(input.environment)),
  ].join("\n");
}

function sectionLines(title: string, lines: string[]): string[] {
  return [`## ${title}`, ...lines];
}

function rowLine(row: RuntimeInfoRow): string {
  return `- ${inline(row.label)}: ${inline(row.value)}${row.note ? `（${inline(row.note)}）` : ""}`;
}

/** 値や注記に改行・タブが混ざると行構造が壊れるため、コピー時は空白 1 つへ畳む */
function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function connectionLines(health: Health | null, healthFailed: boolean): string[] {
  // 画面と同じく、前回値の断り書きを見出しの直後に出す
  const lines = healthFailed ? [HEALTH_RELOAD_FAILED_MESSAGE] : [];
  return [...lines, ...runtimeConnectionRows(health).map(rowLine), ...runtimeVersionRows(health).map(rowLine)];
}

function environmentLines(environment: RuntimeFetchState<RuntimeEnvironmentResponse>): string[] {
  if (environment.status === "loading") return [RUNTIME_ENVIRONMENT_LOADING];
  if (environment.status === "error") return [inline(`${RUNTIME_ENVIRONMENT_ERROR_LEAD}${environment.message}`)];
  if (environment.value.state !== "connected") return [rowLine(runtimeEnvironmentStatusRow(environment.value.state))];
  return [
    runtimeEnvironmentStatusRow("connected"),
    ...runtimeEnvironmentRows(environment.value.environment, environment.value.landlock),
  ].map(rowLine);
}

function commandLines(environment: RuntimeFetchState<RuntimeEnvironmentResponse>): string[] {
  if (environment.status === "loading") return [RUNTIME_COMMANDS_LOADING];
  if (environment.status === "error" || environment.value.state !== "connected") {
    return [RUNTIME_COMMANDS_UNAVAILABLE];
  }
  const rows = runtimeCommandRows(environment.value.commands);
  if (rows.length === 0) return [RUNTIME_COMMANDS_EMPTY];
  // 見出しが「利用可能なコマンド」なので、検出できた分だけである注記はコピーにも残す
  return [...rows.map((row) => `- ${inline(row.name)}: ${inline(row.version)}`), RUNTIME_COMMANDS_FOOTNOTE];
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
