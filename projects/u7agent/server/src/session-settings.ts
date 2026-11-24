/**
 * pi SDK へ渡すセッション 1 件分の設定。compaction・steering・retry の値と、resource loader の組み立てを持つ。
 */
import {
  DefaultResourceLoader,
  SettingsManager,
  type ResourceDiagnostic,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import type { SecretMasker } from "./redact";
import { createSecretRedactionExtension } from "./secret-guard";

/**
 * SDK 1.4.0 で要約の出力枠はモデルの出力上限 (context 残量で切り詰められる) へ移り、この値は自動圧縮の
 * 閾値だけを決める。65,536 は出力枠を確保するために上げた名残で、閾値としては窓の余裕を大きく取る。
 * 下げる (= 圧縮を遅らせる) 変更は発火条件の再検証が要るので、SDK 更新とは分けて扱う。
 */
const DEFAULT_COMPACTION_RESERVE_TOKENS = 65_536;
/** SDK の compaction の既定値 (SettingsManager と同じ) */
const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000;

/**
 * compaction の閾値を下げて発火させやすくする検証用の環境変数を読む。
 * 未設定・不正値 (0 以下・非整数・非数値) は undefined を返し、u7agent の既定を使う (デプロイ影響なし)。
 */
export function parseCompactionTokenKnob(raw: string | undefined): number | undefined {
  const value = Number(raw?.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function compactionSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  enabled: true;
  reserveTokens: number;
  keepRecentTokens: number;
} {
  return {
    enabled: true,
    reserveTokens: parseCompactionTokenKnob(env.PI_COMPACTION_RESERVE_TOKENS) ?? DEFAULT_COMPACTION_RESERVE_TOKENS,
    keepRecentTokens:
      parseCompactionTokenKnob(env.PI_COMPACTION_KEEP_RECENT_TOKENS) ?? DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
  };
}

/**
 * SDK が受付済みの steering を次のモデル判断の前にまとめて注入するモード。1 件ずつ渡す既定では、
 * 入力のたびにモデル判断が走る。セッション作成時の in-memory 設定でだけ指定し、ユーザーの
 * pi 設定ファイルには書き込まない (設定 UI にも出さない)
 */
export const SESSION_STEERING_MODE = "all" as const;

/** セッション設定へ渡す compaction の値 (SDK の Settings の一部) */
type SessionCompactionSettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>["compaction"];

/**
 * セッション 1 件分の in-memory 設定。SDK の設定ファイルを読ませず、値の出所をここへ寄せる。
 * retry は BFF の budget と揃え、steering は `SESSION_STEERING_MODE` を正とする。
 * cacheWarming は既定に任せない: SDK 1.5.1 の既定 `"idle"` は実行と実行のあいだにも
 * プロバイダーへ課金対象のリクエストを送るため、利用者が起こしていない通信を作らない
 */
export function createSessionSettings(
  compaction: SessionCompactionSettings,
): Parameters<typeof SettingsManager.inMemory>[0] {
  return {
    compaction,
    retry: { enabled: true, maxRetries: 2 },
    steeringMode: SESSION_STEERING_MODE,
    cacheWarming: "off",
  };
}

export interface SessionResourceLoaderInput {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  secretMasker: SecretMasker;
  appendSystemPrompt: string[];
  /** サンドボックスで発見済みのファイルスキル。skillsOverride で SDK の一覧へ足す */
  fileSkills?: Skill[];
  /** 子セッションは索引を渡さない (発見もしない)。既定 true */
  injectSkills?: boolean;
}

/**
 * セッションの resource loader。`.pi` / `~/.pi/agent` を読ませないため noSkills は維持したまま、
 * 発見済みのファイルスキルを skillsOverride で注入する (ネイティブ発見・祖先さかのぼりは使わない)。
 */
export function createSessionResourceLoader(input: SessionResourceLoaderInput): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager: input.settingsManager,
    // Web には拡張ダイアログに答える TUI が無いため決定論を優先し、noExtensions でも
    // 読み込まれる extensionFactories だけをインターフェイスにする。
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [createSecretRedactionExtension(input.secretMasker)],
    appendSystemPrompt: input.appendSystemPrompt,
    ...(input.injectSkills === false
      ? {}
      : {
          skillsOverride: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => ({
            skills: [...base.skills, ...(input.fileSkills ?? [])],
            diagnostics: base.diagnostics,
          }),
        }),
  });
}
