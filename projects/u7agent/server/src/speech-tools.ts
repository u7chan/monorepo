/**
 * BFF ローカルの `generate_speech` ツール。サンドボックス実行のリモート定義とは別の層で、
 * `PI_AGENT_TOOLS`（サンドボックスの allowlist）の影響を受けない。
 * 有効化はセッション作成時に固定し、execute は毎回現在の settings を読む（docs/speech-generation.md）。
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { messageFor } from "./http";
import type { SandboxWorkspaceClient } from "./sandbox/client";
import { wrapToolDefinitionWithSecretMasker } from "./secret-guard";
import type { SecretMasker } from "./redact";
import type { SpeechGenerationResult, SpeechGenerationSettings } from "./speech";
import { cwdRelativePath, parseToolPath, rootRelativeDir } from "./workspace-path";

export const SPEECH_TOOL_NAME = "generate_speech";

/** 既定の保存先。`<slug>` は本文から決める */
export const SPEECH_TOOL_DEFAULT_DIR = "generated";
export const SPEECH_TOOL_SLUG_MAX_LENGTH = 40;

/** 課金前に止める本文の上限。モデルごとの per-request 上限はカタログから読めないため保守的に固定する */
export const SPEECH_TOOL_TEXT_MAX_LENGTH = 4_000;

export const SPEECH_TOOL_DESCRIPTION =
  "Generate speech audio from text and save it in the working directory. " +
  "Returns the working-directory-relative path of the saved file.";

export const SPEECH_TOOL_GUIDELINES = [
  "Use generate_speech only when the user asks for new audio; it costs provider credits.",
  "Write only the words to read. The default model reads the input verbatim, so do not put acting directions, narration labels or speaker names in it.",
  "For long text, call generate_speech multiple times with separate parts; concatenating the parts is out of scope.",
  "generate_speech saves generated audio under the working directory (by default `generated/`) and returns the working-directory-relative path.",
  "After generating, show the actual saved path returned by the tool in your reply.",
];

/** 上限超過。分割はエージェントの仕事で、連結の道具はサンドボックスに無いことを文言で伝える */
export const SPEECH_TOOL_TEXT_TOO_LONG_MESSAGE = `音声にする文章が長すぎます（${SPEECH_TOOL_TEXT_MAX_LENGTH.toLocaleString("en-US")} 文字まで）。分割して複数回呼んでください（クレジットは消費していません）`;

/** 保存できるのは mp3 だけ。拡張子の省略時は付ける（pcm を mp3 の名前で保存しない） */
export const SPEECH_TOOL_EXTENSION_MESSAGE =
  "保存できるのは .mp3 だけです（拡張子を省略したときは .mp3 を付けます。クレジットは消費していません）";

export const SPEECH_TOOL_VOICE_MESSAGE =
  "このモデルは選択された声に対応していません（クレジットは消費していません）。設定 → モデル → コンテンツ生成 で選び直すか、対応する声を指定してください";

export const SPEECH_TOOL_KEY_UNSET_MESSAGE =
  "音声APIキーが未設定です。設定 → モデル → コンテンツ生成 でAPIキーを登録してください（画像と共有）";

/** 有効なときだけ system prompt へ足す。生成物の場所と本文での示し方を固定する */
export const SPEECH_GENERATION_PROMPT_LINES = [
  "generate_speech writes only the words to read; the default model reads the input verbatim, so do not include acting directions or narration labels in the text.",
  "For long text, call generate_speech multiple times with separate parts and tell the user the parts are separate files; concatenating them is out of scope.",
  "generate_speech saves generated audio under the working directory (by default `generated/`) and returns the working-directory-relative path.",
  "When you generate audio, always show the actual saved path returned by the tool in your reply.",
];

const generateSpeechSchema = Type.Object({
  text: Type.String({
    description:
      "Text to read aloud. Write only the words to read; the default model reads it verbatim, so do not include acting directions, narration labels or speaker names.",
  }),
  voice: Type.Optional(
    Type.String({
      description:
        "Optional voice name, overriding the voice chosen in the settings. It must be one of the voices the selected model supports; omit to use the configured voice.",
    }),
  ),
  path: Type.Optional(
    Type.String({
      description:
        "Optional path relative to the working directory ending with `.mp3` (for example `generated/narration.mp3`). The `.mp3` extension is added when omitted, and other extensions are refused. Parent directories are created. Existing files are not overwritten; the new file gets a suffix such as `-1` if the name is taken. Always use the actual saved path returned by the tool in your reply.",
    }),
  ),
});
type GenerateSpeechParams = Static<typeof generateSpeechSchema>;

/** プロンプトから既定の保存名を作る。`[a-z0-9-]` へ正規化した 40 文字まで */
export function speechSlug(text: string, now: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SPEECH_TOOL_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  if (slug !== "") return slug;
  // 英数字が 1 文字も取れない本文（日本語だけなど）は日時へ落とす
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `speech-${stamp}`;
}

/** 保存名。`.mp3` 以外は拒否し、拡張子が無いときだけ付ける */
export function speechFileName(name: string): string {
  if (name.toLowerCase().endsWith(".mp3")) return name;
  if (!name.includes(".")) return `${name}.mp3`;
  throw new Error(SPEECH_TOOL_EXTENSION_MESSAGE);
}

export interface SpeechToolDefinitionOptions {
  /** セッション作成時に固定した公開状態 */
  enabled: boolean;
  /** セッションの作業ディレクトリ（rootCwd 相対。"" は root） */
  sessionCwd: string;
  workspace: SandboxWorkspaceClient;
  masker: SecretMasker;
  /** 実行のたびに読む。未設定・削除後は undefined（キー無効エラー） */
  readSettings: () => SpeechGenerationSettings | undefined;
  /** 実行のたびに読むカタログの話者の宣言。未知名・宣言なしは undefined（＝止めない） */
  readVoices: (model: string) => readonly string[] | undefined;
  generate: (input: {
    provider: string;
    model: string;
    text: string;
    voice?: string | undefined;
    apiKey: string;
    signal?: AbortSignal | undefined;
  }) => Promise<SpeechGenerationResult>;
}

export function createSpeechToolDefinitions(options: SpeechToolDefinitionOptions): ToolDefinition[] {
  if (!options.enabled) return [];
  const definition: ToolDefinition<typeof generateSpeechSchema> = {
    name: SPEECH_TOOL_NAME,
    label: SPEECH_TOOL_NAME,
    description: SPEECH_TOOL_DESCRIPTION,
    promptSnippet: "Generate speech audio from text",
    promptGuidelines: [...SPEECH_TOOL_GUIDELINES],
    parameters: generateSpeechSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params: GenerateSpeechParams, signal) {
      // 支出の前に path と本文の長さを検証する。dir と name は実際に保存するまで確定しない
      const explicit =
        params.path === undefined
          ? undefined
          : (() => {
              const target = parseToolPath(params.path);
              return { dir: target.dir, name: speechFileName(target.name) };
            })();
      if (params.text.length > SPEECH_TOOL_TEXT_MAX_LENGTH) throw new Error(SPEECH_TOOL_TEXT_TOO_LONG_MESSAGE);
      const settings = readCurrentSettings(options.readSettings);
      // 引数の声は設定より優先する。空文字は「指定なし」として設定へ委ねる
      const requested = params.voice?.trim();
      const voice = requested ? requested : settings.voice;
      // 保存名を決める段で初めて分かると課金だけが残るため、provider を叩く前に止める
      const declared = options.readVoices(settings.model);
      if (declared && voice !== "" && !declared.includes(voice)) throw new Error(SPEECH_TOOL_VOICE_MESSAGE);

      const result = await options.generate({
        provider: settings.provider,
        model: settings.model,
        text: params.text,
        voice,
        apiKey: settings.apiKey,
        signal,
      });
      if (!result.ok) throw new Error(result.message);

      const dir = explicit?.dir ?? SPEECH_TOOL_DEFAULT_DIR;
      const name = explicit?.name ?? `${speechSlug(params.text, Date.now())}.mp3`;
      const uploaded = await options.workspace.uploadFile({
        dir: rootRelativeDir(options.sessionCwd, dir),
        name,
        body: new Blob([result.speech.audio]).stream(),
        signal,
      });
      // 同名はサンドボックスが `-1` を付けて退避するため、実際に保存された名前を返す
      const path = cwdRelativePath(dir, uploaded.name);
      // 使用モデルとボイスを結果本文へ残す。投影 (toolResultSummary) は先頭 900 文字で切るため、
      // 長い path でも欠けないよう先頭の行に置く（会話履歴は session.jsonl の toolResult を正とする）
      return {
        content: [
          {
            type: "text",
            text:
              `モデル: ${settings.model}\n` +
              `ボイス: ${voice || "（モデル既定）"}\n` +
              `音声を生成して保存しました: ${path}\n` +
              `本文に示すときは、このパス (${path}) を示してください。`,
          },
        ],
        details: undefined,
      };
    },
  };
  return [wrapToolDefinitionWithSecretMasker(definition, options.masker)];
}

/** 未設定・削除後はキー無効エラーにする。作成時のキーは握らず、毎回ここを通す */
function readCurrentSettings(read: () => SpeechGenerationSettings | undefined): SpeechGenerationSettings {
  let settings: SpeechGenerationSettings | undefined;
  try {
    settings = read();
  } catch (error) {
    throw new Error(`音声生成の設定を読み取れませんでした: ${messageFor(error)}`);
  }
  if (!settings) throw new Error(SPEECH_TOOL_KEY_UNSET_MESSAGE);
  return settings;
}
