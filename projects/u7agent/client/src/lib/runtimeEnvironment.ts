/**
 * 設定 → ランタイムの表示変換（行の値・状態文言・一括コピー本文）と、health / 実行環境を
 * まとめて取り直す手順。コンポーネントから切り出して、状態の分岐と古い応答の扱いをテストできるようにする。
 */
import type {
  Health,
  RuntimeEnvironmentResponse,
  RuntimeEnvironmentState,
  RuntimeInUseContent,
  RuntimeInUseResponse,
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
  models: "利用中のモデル",
  integrations: "外部連携",
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

/** 行からコピーする対象。識別子だけを持ち、ラベルや注記は含めない */
export type RuntimeCopyTarget = { text: string; label: string };

/**
 * 画面 1 行分の値。コピー本文もこの値をそのまま使う。`noteCopy` は注記の中の識別子
 * (音声のボイス) をコピーするときに使う。
 */
export type RuntimeInfoRow = {
  label: string;
  value: string;
  note?: string;
  copy?: RuntimeCopyTarget;
  noteCopy?: RuntimeCopyTarget;
};

/** 状態ドットを持つ行 (実行環境の接続状態だけ) */
export type RuntimeStatusRow = RuntimeInfoRow & { tone: RuntimeTone };

/** 接続状態カードの行。health が無いときも「情報なし」で行を残す (欠落を空欄で隠さない) */
export function runtimeConnectionRows(health: Health | null): RuntimeInfoRow[] {
  return [
    { label: "ランタイム", value: health ? (health.ready ? "利用可能" : "利用できません") : "情報なし" },
    { label: "サンドボックス", value: health ? (health.sandboxConfigured ? "設定済み" : "未設定") : "情報なし" },
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

/** 「利用中のモデル」カードの取得状態。失敗はカード内に閉じ、実行環境のカードを巻き込まない */
export const RUNTIME_MODELS_LOADING = "利用中のモデルを取得しています。";
export const RUNTIME_MODELS_ERROR_LEAD = "利用中のモデルを取得できませんでした。";

/** 「外部連携」カードの取得状態。モデルと同じ取得なので、失敗時はモデル側に理由を出す */
export const RUNTIME_INTEGRATIONS_LOADING = "外部連携を取得しています。";
export const RUNTIME_INTEGRATIONS_UNAVAILABLE = "利用中のモデルを取得できていないため、外部連携は表示していません。";

/** 値が無い行の文言。行を消すと「未設定」と「取得できていない」の区別が付かなくなる */
const RUNTIME_UNSET = "未設定";
const RUNTIME_UNKNOWN = "情報なし";
const RUNTIME_UNAVAILABLE = "利用できません";

/** 会話タイトルの状態。無効にしても保存済みモデルは消さない既存仕様のまま出す */
const RUNTIME_TITLE_STATES = {
  disabled: "無効",
  unavailable: "候補外",
  enabled: "有効",
} as const;

/** コンテンツ生成の状態。画像・音声・BGM は 1 つのゲートを共有する */
export type RuntimeContentState = "未設定" | "停止中" | "キー未復号" | "有効";

export function runtimeContentState(content: RuntimeInUseContent): RuntimeContentState {
  if (!content.configured) return "未設定";
  if (!content.enabled) return "停止中";
  if (!content.keyAvailable) return "キー未復号";
  return "有効";
}

/**
 * 「利用中のモデル」カードの行。既定モデルの正は health（in-use API には含めない）で、
 * `health.model` の欠落を「未設定」と同一視しない。
 */
export function runtimeModelRows(health: Health | null, inUse: RuntimeInUseResponse | null): RuntimeInfoRow[] {
  return [
    runtimeDefaultModelRow(health),
    runtimeTitleRow(inUse?.title ?? null),
    ...runtimeContentRows(inUse?.content ?? null),
  ];
}

function runtimeDefaultModelRow(health: Health | null): RuntimeInfoRow {
  const label = "既定モデル";
  if (!health) return { label, value: RUNTIME_UNKNOWN };
  if (health.model) {
    return {
      label,
      value: health.model,
      note: RUNTIME_DEFAULT_MODEL_NOTE,
      copy: { text: health.model, label: "既定モデルのIDをコピー" },
    };
  }
  // 解決できなかった理由が分かるものだけを、上から順に 1 つ選ぶ (推測で「未設定」と断定しない)
  if (health.defaultModelUnset) return { label, value: RUNTIME_UNSET };
  if (health.defaultModelError) return { label, value: RUNTIME_UNAVAILABLE, note: health.defaultModelError };
  if (health.availabilityError) return { label, value: RUNTIME_UNAVAILABLE, note: health.availabilityError };
  return { label, value: RUNTIME_UNKNOWN };
}

function runtimeTitleRow(title: RuntimeInUseResponse["title"] | null): RuntimeInfoRow {
  const label = "会話タイトル";
  if (!title) return { label, value: RUNTIME_UNKNOWN };
  if (title.model === null) return { label, value: "未選択" };
  // 保存値の thinkingLevel は能力変更や未指定で実効値と食い違うため、実効値だけを出す
  const state = runtimeTitleStateNote(title);
  const note = [state, title.effectiveThinkingLevel ? `Effort: ${title.effectiveThinkingLevel}` : null]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return identifierRow(label, title.model, "会話タイトルのモデルIDをコピー", "未選択", note);
}

function runtimeTitleStateNote(title: RuntimeInUseResponse["title"]): string {
  if (!title.enabled) {
    return `${RUNTIME_TITLE_STATES.disabled}（AI要約は行いません。保存済みのモデルは残ります）`;
  }
  if (!title.modelAvailable) {
    return `${RUNTIME_TITLE_STATES.unavailable}（現在の候補に無いため要約しません）`;
  }
  return RUNTIME_TITLE_STATES.enabled;
}

/** 識別子の行。null は「未選択」と「取得できていない」を呼び出し側の文言で分ける */
function identifierRow(
  label: string,
  id: string | null,
  copyLabel: string,
  missing: string,
  note?: string,
  noteCopy?: RuntimeCopyTarget,
): RuntimeInfoRow {
  const row: RuntimeInfoRow = { label, value: id ?? missing };
  if (note) row.note = note;
  if (noteCopy) row.noteCopy = noteCopy;
  if (id) row.copy = { text: id, label: copyLabel };
  return row;
}

function runtimeContentRows(content: RuntimeInUseContent | null): RuntimeInfoRow[] {
  const missing = content ? RUNTIME_UNSET : RUNTIME_UNKNOWN;
  const voice = runtimeSpeechVoice(content);
  return [
    {
      label: "コンテンツ生成",
      value: content ? runtimeContentState(content) : RUNTIME_UNKNOWN,
      ...(content ? runtimeContentStateNote(content) : {}),
    },
    identifierRow("画像生成モデル", content?.imageModel ?? null, "画像生成モデルのIDをコピー", missing),
    identifierRow(
      "音声モデル",
      content?.speechModel ?? null,
      "音声モデルのIDをコピー",
      missing,
      voice.note,
      voice.copy,
    ),
    identifierRow("BGM モデル", content?.bgmModel ?? null, "BGM モデルのIDをコピー", missing),
  ];
}

function runtimeContentStateNote(content: RuntimeInUseContent): { note: string } | undefined {
  switch (runtimeContentState(content)) {
    case "未設定":
      return { note: "コンテンツ生成の設定がありません。" };
    case "停止中":
      return { note: "コンテンツ生成は停止中です。" };
    case "キー未復号":
      return { note: "APIキーを復号できません。" };
    default:
      return undefined;
  }
}

/** ボイスの空文字は API が null（指定なし）へ正規化している。指定なしをコピーさせない */
function runtimeSpeechVoice(content: RuntimeInUseContent | null): { note?: string; copy?: RuntimeCopyTarget } {
  if (!content || content.speechModel === null) return {};
  if (content.speechVoice === null) return { note: "ボイス: 指定なし" };
  return {
    note: `ボイス: ${content.speechVoice}`,
    copy: { text: content.speechVoice, label: "音声のボイスをコピー" },
  };
}

/** 「外部連携」カードの行。モデルではないため「利用中のモデル」へ混ぜない */
export function runtimeIntegrationRows(inUse: RuntimeInUseResponse | null): RuntimeInfoRow[] {
  return [runtimeWebSearchRow(inUse), runtimeCloudflareRow(inUse)];
}

function runtimeWebSearchRow(inUse: RuntimeInUseResponse | null): RuntimeInfoRow {
  const label = "Web 検索";
  if (!inUse) return { label, value: RUNTIME_UNKNOWN };
  const { enabled, provider, host } = inUse.webSearch;
  return {
    label,
    value: provider,
    note: `${host} · ${enabled ? "有効" : "停止中"}`,
    copy: { text: provider, label: "Web 検索の provider ID をコピー" },
  };
}

function runtimeCloudflareRow(inUse: RuntimeInUseResponse | null): RuntimeInfoRow {
  const label = "Cloudflare";
  if (!inUse) return { label, value: RUNTIME_UNKNOWN };
  const { available, accountId } = inUse.cloudflare;
  const row: RuntimeInfoRow = { label, value: accountId ?? RUNTIME_UNSET };
  if (!available) row.note = "利用できません（サーバーの master key が未設定です）";
  else if (accountId) row.note = "設定済み";
  if (accountId) row.copy = { text: accountId, label: "Cloudflare のアカウントIDをコピー" };
  return row;
}

export type RuntimeReloadOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

export type RuntimeReloadResults = {
  /** includeHealth が false のときは null (親が持つ health をそのまま使う) */
  health: RuntimeReloadOutcome<Health> | null;
  inUse: RuntimeReloadOutcome<RuntimeInUseResponse>;
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
  getInUse: () => Promise<RuntimeInUseResponse>;
  getEnvironment: () => Promise<RuntimeEnvironmentResponse>;
};

/**
 * health・利用中のモデル・実行環境をまとめて取得する。1 系統の失敗で他を捨てず、全 settled を待つ。
 * 古い応答を適用しない判定は呼び出し側 (createRuntimeReloadGate) が持つ。
 */
export async function reloadRuntime(input: RuntimeReloadInput): Promise<RuntimeReloadResults> {
  if (!input.includeHealth) {
    const [inUse, environment] = await Promise.allSettled([input.getInUse(), input.getEnvironment()]);
    return { health: null, inUse: outcomeOf(inUse), environment: outcomeOf(environment) };
  }
  const [health, inUse, environment] = await Promise.allSettled([
    refreshHealthOrFail(input.refreshHealth, input.isCurrent),
    input.getInUse(),
    input.getEnvironment(),
  ]);
  return { health: outcomeOf(health), inUse: outcomeOf(inUse), environment: outcomeOf(environment) };
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
  inUse: RuntimeFetchState<RuntimeInUseResponse>;
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
    ...sectionLines(RUNTIME_SECTION_TITLES.models, modelLines(input.health, input.inUse)),
    "",
    ...sectionLines(RUNTIME_SECTION_TITLES.integrations, integrationLines(input.inUse)),
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

function modelLines(health: Health | null, inUse: RuntimeFetchState<RuntimeInUseResponse>): string[] {
  if (inUse.status === "loading") return [RUNTIME_MODELS_LOADING];
  if (inUse.status === "error") return [inline(`${RUNTIME_MODELS_ERROR_LEAD}${inUse.message}`)];
  return runtimeModelRows(health, inUse.value).map(rowLine);
}

function integrationLines(inUse: RuntimeFetchState<RuntimeInUseResponse>): string[] {
  if (inUse.status === "loading") return [RUNTIME_INTEGRATIONS_LOADING];
  if (inUse.status === "error") return [RUNTIME_INTEGRATIONS_UNAVAILABLE];
  return runtimeIntegrationRows(inUse.value).map(rowLine);
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
