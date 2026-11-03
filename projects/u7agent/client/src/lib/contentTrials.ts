/**
 * 設定 → コンテンツ生成の試行ジョブの表示変換。DOM に依存しない純関数だけを置き、
 * 状態ラベル・証拠の判定・タブの印の優先順位・履歴の行をテストできるようにする。
 */
import type { ContentSubsection } from "./settingsNav";
import type { ContentTrial, ContentTrialStateValue } from "../types";
import { speechSpeed } from "./contentSettings";
import { messageTimeLabel, yearMonthLabel, type MessageTimeOptions } from "./messageTime";
import { formatDurationMs } from "./usageFormat";

/** 状態の表示名。`interrupted` は再起動で実行中を持ち越せなかったことを表す */
export const TRIAL_STATE_LABELS: Record<ContentTrialStateValue, string> = {
  running: "実行中",
  succeeded: "成功",
  failed: "失敗",
  canceled: "中止",
  interrupted: "中断（再起動）",
};

/** provider の失敗分類の表示名。分類できない失敗は `unknown`、保存できなかった成功は `storage` */
export const TRIAL_FAILURE_LABELS: Record<string, string> = {
  invalid_key: "APIキーが無効",
  insufficient_credit: "残高不足",
  rate_limited: "混雑・レート制限",
  timeout: "タイムアウト",
  aborted: "中断",
  storage: "結果を保存できない",
  unknown: "原因不明",
};

export function trialStateLabel(state: ContentTrialStateValue): string {
  return TRIAL_STATE_LABELS[state];
}

/** 失敗の分類。分類が無い（キャンセル・中断）ときは null */
export function trialFailureLabel(code: string | null): string | null {
  if (code === null) return null;
  return TRIAL_FAILURE_LABELS[code] ?? TRIAL_FAILURE_LABELS.unknown;
}

/**
 * 証拠の時刻。相対表記は「たった今 / N 分前 / N 時間前 / N 日前」だけにし、それより古いものは
 * 日付（今日なら時刻）へ落とす。分単位の表記は履歴の比較に要る粒度で、秒は出さない。
 */
export function trialAgeLabel(at: number, now: number, options: MessageTimeOptions = {}): string {
  const diff = now - at;
  if (diff < 60_000) return "たった今";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 時間前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 日前`;
  return messageTimeLabel(at, { ...options, now });
}

/** 所要時間。分からない（中断・記録前）ときは `—`。前回の実測だけを出し、平均は出さない */
export function trialDurationLabel(durationMs: number | null): string {
  return durationMs === null ? "—" : formatDurationMs(durationMs);
}

/** 証拠の判定。現在のキー世代と選択中のモデルに一致する実績だけを数える */
export type TrialEvidence =
  | { kind: "success"; at: number; durationMs: number | null }
  | { kind: "failure"; at: number; code: string | null; message: string | null }
  | { kind: "unverified" };

/**
 * モデル選択の直下に出す証拠。現在のキー世代・現在のモデル（音声はボイスも）の `succeeded` が最新なら成功、
 * 無ければ同じ条件の `failed` の最新を出し、どちらも無ければ未確認にする（緑のバッジは作らない）。
 * 旧キー・別モデル・別ボイスの実績は履歴にだけ残し、現在の証拠にしない。
 */
export function trialEvidence(input: {
  trials: readonly ContentTrial[];
  currentKeyEpoch: number;
  currentModel: string;
  /** 音声はボイスも一致する実績だけを現在の証拠にする。画像は undefined */
  currentVoice?: string | null;
  now: number;
}): TrialEvidence {
  const current = input.trials.filter(
    (trial) =>
      trial.keyEpoch === input.currentKeyEpoch &&
      trial.model === input.currentModel &&
      (input.currentVoice === undefined || voiceKey(trial.voice) === voiceKey(input.currentVoice)),
  );
  const at = (trial: ContentTrial): number => trial.finishedAt ?? trial.startedAt;
  // 段階 2 以降の証拠は「保存済みの成果物がある成功」だけを数える。段階 1 の `none` 行は履歴にだけ残す
  const succeeded = current
    .filter((trial) => trial.state === "succeeded" && trial.artifactState === "stored")
    .sort((a, b) => at(b) - at(a))[0];
  if (succeeded) {
    return { kind: "success", at: at(succeeded), durationMs: succeeded.durationMs };
  }
  const failed = current.filter((trial) => trial.state === "failed").sort((a, b) => at(b) - at(a))[0];
  if (failed) {
    return { kind: "failure", at: at(failed), code: failed.failureCode, message: failed.failureMessage };
  }
  return { kind: "unverified" };
}

/**
 * 証拠の 1 行。成功には所要時間を添える。分類の文言は provider の原文ではなく固定の短い名前を使う
 * （原文は履歴の行に出す）。
 */
export function evidenceNote(
  evidence: TrialEvidence,
  options: { now: number; messageTime?: MessageTimeOptions },
): string {
  if (evidence.kind === "unverified") return "この画面での成功: 未確認";
  const age = trialAgeLabel(evidence.at, options.now, options.messageTime);
  if (evidence.kind === "failure") {
    const label = trialFailureLabel(evidence.code) ?? "原因不明";
    return `直近の失敗: ${label}（${age}）`;
  }
  const duration = evidence.durationMs === null ? "" : `（${trialDurationLabel(evidence.durationMs)}）`;
  return `この画面での最終成功: ${age}${duration}`;
}

/**
 * ボイスの比較キー。空文字（画面の「指定なし」）と null（サーバーが保存する未指定）は同じ「ボイス未指定」を
 * 表すため、証拠と再利用の判定で同じ表現へ寄せる。
 */
function voiceKey(voice: string | null | undefined): string {
  return voice ?? "";
}

/** 履歴の 1 行。現在のキー世代より古い行は「旧キー」として区別する */
export interface TrialHistoryRow {
  id: string;
  stateLabel: string;
  state: ContentTrialStateValue;
  model: string;
  /** 音声のボイス（送信時の値）。画像の行は null */
  voice: string | null;
  durationLabel: string;
  keyEpochLabel: string | null;
  prompt: string;
  failureLabel: string | null;
  at: number;
  /** 保存済みの成果物の配信 URL。保存していない行（段階 1 の `none`）は null */
  artifactUrl: string | null;
  /** 画像の実寸と形式・サイズ。成果物が無いときは null */
  artifactLabel: string | null;
  /** 課金されたのに結果を残せなかった行。再生成で再課金されることを行にも出す */
  chargedWithoutArtifact: boolean;
}

export function trialHistoryRow(trial: ContentTrial, currentKeyEpoch: number): TrialHistoryRow {
  return {
    id: trial.id,
    state: trial.state,
    stateLabel: trialStateLabel(trial.state),
    model: trial.model,
    voice: trial.voice,
    durationLabel: trialDurationLabel(trial.durationMs),
    keyEpochLabel: trial.keyEpoch < currentKeyEpoch ? `旧キー（世代 ${trial.keyEpoch}）` : null,
    prompt: trial.prompt,
    // 分類を出すのは失敗だけ。中止（利用者の操作）や中断（再起動）を失敗の分類として見せない
    failureLabel: trial.state === "failed" ? trialFailureLabel(trial.failureCode) : null,
    at: trial.finishedAt ?? trial.startedAt,
    artifactUrl: hasStoredArtifact(trial) ? trialArtifactUrl(trial.id) : null,
    artifactLabel: trialArtifactSummary(trial),
    chargedWithoutArtifact: trial.charged && trial.artifact === null,
  };
}

/**
 * 試行の面の状態。未設定 / runtime 不可 / 全体 OFF / 同期未確認 / 空 / 実行中 / 失敗 / 中断の
 * どれを主に出すかを 1 箇所で決める（文言は呼び出し側が写す）。
 */
export type TrialPanelState =
  | "runtime_unavailable"
  | "unconfigured"
  | "disabled"
  | "unsynced"
  | "empty"
  | "running"
  | "failed"
  | "interrupted"
  | "ready";

export function trialPanelState(input: {
  runtimeAvailable: boolean;
  configured: boolean;
  enabled: boolean;
  /** 音声の同期が確認できていない。画像の面では常に true */
  synced: boolean;
  trials: readonly ContentTrial[];
}): TrialPanelState {
  if (!input.runtimeAvailable) return "runtime_unavailable";
  if (!input.configured) return "unconfigured";
  // 同期未確認は保存だけを止める状態で、試行は画面の値でできる（面では注記に留める）
  if (!input.synced) return "unsynced";
  if (!input.enabled) return "disabled";
  if (input.trials.some((trial) => trial.state === "running")) return "running";
  const latest = input.trials[0];
  if (!latest) return "empty";
  if (latest.state === "failed") return "failed";
  if (latest.state === "interrupted") return "interrupted";
  return "ready";
}

/** 試行を開始できない理由。null なら開始できる */
export function trialStartBlockedReason(input: {
  runtimeAvailable: boolean;
  configured: boolean;
  enabled: boolean;
  keyAvailable: boolean;
  running: boolean;
  prompt: string;
  /** 空のときの文言。音声は「本文」、画像は既定の「プロンプト」 */
  emptyPromptReason?: string;
}): string | null {
  if (!input.runtimeAvailable) return "ランタイムが利用できないため試行できません";
  if (!input.configured) return "APIキーを登録すると試行できます";
  if (!input.enabled) return "全体が OFF のため試行できません（履歴は残ります）";
  if (!input.keyAvailable) return "保存済みのAPIキーを使えないため試行できません";
  if (input.running) return "実行中です。完了するか中断してください";
  if (input.prompt.trim() === "") return input.emptyPromptReason ?? "プロンプトを入力してください";
  return null;
}

/** 種別の表示名。削除の注記など、画面の文言に使う */
export function trialKindLabel(kind: ContentTrial["kind"]): string {
  if (kind === "speech") return "音声";
  if (kind === "bgm") return "BGM";
  return "画像";
}

/**
 * 種別ごとの全削除の注記。消した件数は渡された種別の履歴だけを数えるため、
 * 文言にも種別を入れて「もう一方のタブの履歴は消えていない」ことが読み取れるようにする。
 */
export function trialRemoveAllNote(kind: ContentTrial["kind"], removed: number): string {
  const label = trialKindLabel(kind);
  return removed === 0
    ? `${label}の試行に削除できる履歴がありません（実行中の試行は残ります）。`
    : `${label}の試行の履歴を ${removed} 件削除しました（実行中の試行は残ります）。`;
}

/** 試行の種別と設定タブの対応。印はタブ単位で出す */
export function trialKindSubsection(kind: ContentTrial["kind"]): ContentSubsection {
  switch (kind) {
    case "image":
      return "image";
    case "speech":
      return "speech";
    case "bgm":
      return "bgm";
  }
}

/**
 * タブの印。優先順位は 実行中（accent の点 + pulse）> 同期未確認（warn の点、開いても消えない）>
 * 新着結果（warn の点、開いたら消える）。読み上げ名も状態ごとに分ける。
 */
export interface TabIndicator {
  dot: "accent" | "warn" | null;
  pulse: boolean;
  ariaLabel: string | null;
}

export function tabIndicator(input: {
  label: string;
  running: boolean;
  unsynced: boolean;
  newResult: boolean;
}): TabIndicator {
  if (input.running) return { dot: "accent", pulse: true, ariaLabel: `${input.label}（生成中）` };
  if (input.unsynced) return { dot: "warn", pulse: false, ariaLabel: `${input.label}（現在の設定を確認できません）` };
  if (input.newResult) return { dot: "warn", pulse: false, ariaLabel: `${input.label}（新しい結果があります）` };
  return { dot: null, pulse: false, ariaLabel: null };
}

/**
 * 新しく終端した試行の種別。前回の一覧で `running` だった行が今回の一覧で終端になり、かつ
 * その種別のタブが開いていなければ「新着結果」として印を出す（ページ再訪時は前回の一覧が無いので出ない）。
 */
export function newlyFinishedKinds(input: {
  previous: readonly ContentTrial[] | null;
  next: readonly ContentTrial[];
  activeSubsection: ContentSubsection | null;
}): ContentTrial["kind"][] {
  if (input.previous === null) return [];
  const wasRunning = new Set(input.previous.filter((trial) => trial.state === "running").map((trial) => trial.id));
  const kinds = new Set<ContentTrial["kind"]>();
  for (const trial of input.next) {
    if (trial.state === "running") continue;
    if (!wasRunning.has(trial.id)) continue;
    const subsection = trialKindSubsection(trial.kind);
    if (subsection === input.activeSubsection) continue;
    kinds.add(trial.kind);
  }
  return [...kinds];
}

/** 実行中の試行が 1 件でもあるか。ポーリングの要否を決める */
export function hasRunningTrial(trials: readonly ContentTrial[]): boolean {
  return trials.some((trial) => trial.state === "running");
}

/** 履歴に出す最新の試行。既定選択は最新 1 件 */
export function latestTrial(trials: readonly ContentTrial[]): ContentTrial | null {
  return trials[0] ?? null;
}

/** 保存済みの成果物があるか。段階 1 の `none` 行は再生・ダウンロードの対象外 */
export function hasStoredArtifact(trial: ContentTrial): boolean {
  return trial.state === "succeeded" && trial.artifactState === "stored" && trial.artifact !== null;
}

/** 成果物の配信 URL。trial id だけで引き、ダウンロードも同じルートを使う（パスを組み立てない） */
export function trialArtifactUrl(id: string, options: { download?: boolean } = {}): string {
  const base = `/api/settings/content/trials/${encodeURIComponent(id)}/raw`;
  return options.download ? `${base}?download=1` : base;
}

/** ファイルサイズ。1 MiB 未満は KiB で出し、桁を増やさない */
export function trialByteSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const FORMAT_LABELS: Record<string, string> = { png: "PNG", jpeg: "JPEG", webp: "WebP", mp3: "MP3", wav: "WAV" };

/** 実寸。保存時に読めなかった（寸法の無い）成果物は出さない */
export function trialDimensionLabel(trial: ContentTrial): string | null {
  const artifact = trial.artifact;
  if (!artifact || artifact.width === null || artifact.height === null) return null;
  return `${artifact.width} × ${artifact.height}`;
}

/** 形式・実寸・サイズの 1 行。成果物が無い行は null（「記録のみ」は呼び出し側が出す） */
export function trialArtifactSummary(trial: ContentTrial): string | null {
  const artifact = trial.artifact;
  if (!artifact) return null;
  const parts = [FORMAT_LABELS[artifact.format] ?? artifact.format.toUpperCase()];
  const dimensions = trialDimensionLabel(trial);
  if (dimensions) parts.push(dimensions);
  parts.push(trialByteSizeLabel(artifact.bytes));
  return parts.join(" · ");
}

/** 履歴の絞り込み。モデルは試行時の値（現在の保存値ではない）で絞る */
export type TrialOutcomeFilter = "all" | "succeeded" | "failed";

export function filteredTrials(input: {
  trials: readonly ContentTrial[];
  model: string;
  outcome: TrialOutcomeFilter;
}): ContentTrial[] {
  return input.trials.filter((trial) => {
    if (input.model !== "all" && trial.model !== input.model) return false;
    if (input.outcome === "all") return true;
    // 中止・中断は「成功」でも「失敗」でもない（絞り込みのどちらにも出さない）
    return trial.state === input.outcome;
  });
}

/** 履歴に出すモデルの選択肢。試行に出てきた値だけを新しい順で重複なく並べる */
export function trialModelOptions(trials: readonly ContentTrial[]): string[] {
  return [...new Set(trials.map((trial) => trial.model))];
}

/** 月区切りの 1 かたまり。`label` は表示名で、`key` は同じ月をまとめる識別子 */
export interface TrialMonthGroup {
  key: string;
  label: string;
  trials: ContentTrial[];
}

/**
 * 履歴を月でまとめる（新しい順は保ったまま）。時間ベースの自動削除はしないため、
 * 半年前の行も別の月として残る。
 */
export function groupTrialsByMonth(
  trials: readonly ContentTrial[],
  options: MessageTimeOptions = {},
): TrialMonthGroup[] {
  const groups: TrialMonthGroup[] = [];
  for (const trial of trials) {
    const at = trial.finishedAt ?? trial.startedAt;
    const key = yearMonthLabel(at, options);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.trials.push(trial);
      continue;
    }
    groups.push({ key, label: key, trials: [trial] });
  }
  return groups;
}

/**
 * ビューポートに出す試行。選択中の id が一覧に無ければ（削除・別種別へ切替）最新へ戻す。
 */
export function selectedTrial(input: {
  trials: readonly ContentTrial[];
  selectedId: string | null;
}): ContentTrial | null {
  if (input.selectedId !== null) {
    const found = input.trials.find((trial) => trial.id === input.selectedId);
    if (found) return found;
  }
  return latestTrial(input.trials);
}

/**
 * 試行を 1 件消した後に一覧を取り直す。保存容量（`artifactUsage`）は一覧の応答にしか載らないため、
 * 行だけをローカルから除くと画面の容量が古いまま残る（[すべて削除] と同じ経路に揃える）。
 * 取り直しに失敗したときは false を返し、呼び出し側が「消えたが一覧を取り直せない」と伝えられるようにする。
 */
export async function removeTrialThenRefresh(input: {
  id: string;
  remove: (id: string) => Promise<unknown>;
  reload: () => Promise<boolean>;
}): Promise<boolean> {
  await input.remove(input.id);
  return input.reload();
}

/** 音声の試行の下書き。本文・演技指示・話速は試行にだけ使い、履歴にスナップショットとして残る */
export interface SpeechTrialDraft {
  text: string;
  instructions: string;
  speed: string;
}

export const EMPTY_SPEECH_TRIAL_DRAFT: SpeechTrialDraft = { text: "", instructions: "", speed: "" };

/** 音声の試行の要求。速度欄の解釈と空本文の拒否をクライアント側でも行い、課金前に止める */
export function speechTrialInput(
  draft: SpeechTrialDraft,
  model: string,
  voice: string,
):
  | { ok: true; input: { model: string; prompt: string; voice?: string; instructions?: string; speed?: number } }
  | { ok: false; error: string } {
  if (model === "") return { ok: false, error: "音声モデルを選択してください" };
  if (draft.text.trim() === "")
    return { ok: false, error: "読み上げる文章を入力してください（クレジットは消費していません）" };
  const speed = speechSpeed(draft.speed);
  if (!speed.ok) return speed;
  return {
    ok: true,
    input: {
      model,
      prompt: draft.text,
      ...(voice === "" ? {} : { voice }),
      ...(draft.instructions.trim() === "" ? {} : { instructions: draft.instructions }),
      ...(speed.speed === undefined ? {} : { speed: speed.speed }),
    },
  };
}

/** 履歴の試行から音声の下書きを戻す（「入力欄に戻す」）。話速は欄の値として小数 2 桁まで出す */
export function speechTrialDraftOf(trial: Pick<ContentTrial, "prompt" | "instructions" | "speed">): SpeechTrialDraft {
  return {
    text: trial.prompt,
    instructions: trial.instructions ?? "",
    speed: trial.speed === null ? "" : String(trial.speed),
  };
}

/** 送信時のスナップショットの 1 行。未指定は「モデル既定」として、何を送ったかを見失わせない */
export function speechTrialSnapshotLabels(trial: Pick<ContentTrial, "voice" | "instructions" | "speed">): {
  voice: string;
  instructions: string;
  speed: string;
} {
  return {
    voice: trial.voice ?? "モデル既定",
    instructions: trial.instructions ?? "指定なし",
    speed: trial.speed === null ? "モデル既定" : `${trial.speed} 倍`,
  };
}

/**
 * BGM のプロンプト上限。チャットの `generate_bgm` と同じ 1,000 文字にして、設定画面とチャットで
 * 受ける依頼の長さを揃える（試行 API 自体の上限はもっと大きい）。
 */
export const BGM_TRIAL_PROMPT_MAX_LENGTH = 1_000;

/** BGM の試行の要求。空白だけのプロンプトと長すぎる入力をクライアント側でも止め、課金前に返す */
export function bgmTrialInput(
  prompt: string,
  model: string,
): { ok: true; input: { kind: "bgm"; model: string; prompt: string } } | { ok: false; error: string } {
  if (model === "") return { ok: false, error: "BGM のモデルを取得できていません。再読み込みしてください" };
  if (prompt.trim() === "")
    return { ok: false, error: "BGM のプロンプトを入力してください（クレジットは消費していません）" };
  if (prompt.length > BGM_TRIAL_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      error: `BGM のプロンプトが長すぎます（${BGM_TRIAL_PROMPT_MAX_LENGTH.toLocaleString("en-US")} 文字まで。クレジットは消費していません）`,
    };
  }
  return { ok: true, input: { kind: "bgm", model, prompt } };
}

/**
 * 実測の尺。ブラウザーが読めた秒数だけを出し、読めていない間は `—` にする
 * （モデル仕様の目安尺と混ぜず、実測が無いものを尺として見せない）。
 */
export function bgmDurationLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  return `${seconds.toFixed(1)} 秒`;
}
