/**
 * BFF ローカルの `generate_image` ツール。サンドボックス実行のリモート定義とは別の層で、
 * `PI_AGENT_TOOLS`（サンドボックスの allowlist）の影響を受けない。
 * 有効化はセッション作成時に固定し、execute は毎回現在の settings を読む（docs/image-generation.md）。
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { messageFor } from "./http";
import {
  isUnsaveableOutputOnly,
  saveableImageFormat,
  type GeneratedImage,
  type ImageGenerationResult,
  type ImageGenerationSettings,
  type SaveableImageFormat,
} from "./images";
import type { SandboxWorkspaceClient } from "./sandbox/client";
import { wrapToolDefinitionWithSecretMasker } from "./secret-guard";
import type { SecretMasker } from "./redact";
import { SPEECH_TOOL_NAME } from "./speech-tools";
import { cwdRelativePath, parseToolPath, rootRelativeDir } from "./workspace-path";

export const IMAGE_TOOL_NAME = "generate_image";

/** 既定の保存先。`<slug>` はプロンプト、`<ext>` は保存する mimeType から決める */
export const IMAGE_TOOL_DEFAULT_DIR = "generated";
export const IMAGE_TOOL_SLUG_MAX_LENGTH = 40;

export const IMAGE_TOOL_DESCRIPTION =
  "Generate an image from a text prompt and save it in the working directory. " +
  "Returns the working-directory-relative path of the saved file. " +
  "Show the generated image in your reply as a Markdown image, for example ![alt](generated/name.png).";

export const IMAGE_TOOL_GUIDELINES = [
  "Use generate_image only when the user asks for a new image; it costs provider credits.",
  "After generating, show the saved file as a Markdown image using the working-directory-relative path returned by the tool instead of pasting the path alone.",
];

/** 保存できる形式を 1 つも宣言していないモデルを生成前に止めるときの文言。課金前であることを明示する */
export const IMAGE_TOOL_UNSAVEABLE_MODEL_MESSAGE =
  "この画像モデルは png / jpeg / webp を返さないため、生成は行っていません（クレジットは消費していません）。設定 → コンテンツ生成 で別の画像モデルを選んでください";

/** 有効なときだけ system prompt へ足す。生成物の場所と本文での示し方を固定する */
export const IMAGE_GENERATION_PROMPT_LINES = [
  "generate_image saves generated images under the working directory (by default `generated/`) and returns the working-directory-relative path.",
  "When you generate an image, always show it in your reply as a Markdown image using the actual saved path returned by the tool, for example ![description](generated/name.png), not the requested path or a fixed-name latest copy.",
  "Do not overwrite existing generated files; keep each unique saved file unchanged so past conversation images remain intact.",
  "If a fixed-name latest copy is needed, use `cp` to a separate path while keeping the unique generated file. Never use `mv` to move a file referenced by the conversation.",
];

/** SDK の tools へ渡す登録名。画像 / 音声のツールは有効なときだけ足す */
export function sessionToolNames(base: readonly string[], enabled: { image: boolean; speech: boolean }): string[] {
  return [...base, ...(enabled.image ? [IMAGE_TOOL_NAME] : []), ...(enabled.speech ? [SPEECH_TOOL_NAME] : [])];
}

const generateImageSchema = Type.Object({
  prompt: Type.String({ description: "Text prompt describing the image to generate" }),
  path: Type.Optional(
    Type.String({
      description:
        "Optional path relative to the working directory (for example `generated/cafe.png`). Parent directories are created. Existing files are not overwritten; the new file gets a suffix such as `-1` if the name is taken. Always use the actual saved path returned by the tool in your reply, and keep that unique file unchanged. If a fixed-name latest copy is needed, use `cp` to a separate path while retaining the generated file; never `mv` a file referenced by the conversation.",
    }),
  ),
});
type GenerateImageParams = Static<typeof generateImageSchema>;

/** プロンプトから既定の保存名を作る。`[a-z0-9-]` へ正規化した 40 文字まで */
export function imageSlug(prompt: string, now: number): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, IMAGE_TOOL_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  if (slug !== "") return slug;
  // 英数字が 1 文字も取れないプロンプト（日本語だけなど）は日時へ落とす
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `image-${stamp}`;
}

/**
 * 保存拡張子は mimeType から決める（provider の応答を正とする）。ここへ来るのは生成成功の後だけなので、
 * 課金済みであることと次に取れる行動まで文言に含める。
 */
export function imageExtensionFor(mimeType: string): SaveableImageFormat {
  const extension = saveableImageFormat(mimeType);
  if (extension) return extension;
  throw new Error(
    `対応していない画像形式です: ${mimeType}（生成は完了しており、クレジットは消費されています）。設定 → コンテンツ生成 で別の画像モデルを選んでください`,
  );
}

/** base64 の画像をアップロード用のストリームにする */
function imageBody(image: GeneratedImage): ReadableStream<Uint8Array> {
  return new Blob([new Uint8Array(Buffer.from(image.data, "base64"))]).stream();
}

export interface ImageToolDefinitionOptions {
  /** セッション作成時に固定した公開状態 */
  enabled: boolean;
  /** セッションの作業ディレクトリ（rootCwd 相対。"" は root） */
  sessionCwd: string;
  workspace: SandboxWorkspaceClient;
  masker: SecretMasker;
  /** 実行のたびに読む。未設定・削除後は undefined（キー無効エラー） */
  readSettings: () => ImageGenerationSettings | undefined;
  /** 実行のたびに読むカタログの形式宣言。未知名・宣言なしは undefined（＝止めない） */
  readOutputFormats: (model: string) => readonly string[] | undefined;
  generate: (input: {
    provider: string;
    model: string;
    prompt: string;
    apiKey: string;
    signal?: AbortSignal | undefined;
  }) => Promise<ImageGenerationResult>;
}

export function createImageToolDefinitions(options: ImageToolDefinitionOptions): ToolDefinition[] {
  if (!options.enabled) return [];
  const definition: ToolDefinition<typeof generateImageSchema> = {
    name: IMAGE_TOOL_NAME,
    label: IMAGE_TOOL_NAME,
    description: IMAGE_TOOL_DESCRIPTION,
    promptSnippet: "Generate an image from a prompt",
    promptGuidelines: [...IMAGE_TOOL_GUIDELINES],
    parameters: generateImageSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params: GenerateImageParams, signal) {
      // 支出の前に path と形式を検証する。dir と name は実際に保存するまで確定しない
      const explicit = params.path === undefined ? undefined : parseToolPath(params.path);
      const settings = readCurrentSettings(options.readSettings);
      // 保存名を決める段で初めて分かると生成だけが成功して課金が残るため、provider を叩く前に止める
      if (isUnsaveableOutputOnly(options.readOutputFormats(settings.model))) {
        throw new Error(IMAGE_TOOL_UNSAVEABLE_MODEL_MESSAGE);
      }
      const result = await options.generate({
        provider: settings.provider,
        model: settings.model,
        prompt: params.prompt,
        apiKey: settings.apiKey,
        signal,
      });
      if (!result.ok) throw new Error(result.message);

      // 明示 path は拡張子も含めてそのまま使う。省略時だけ mimeType から決める
      const dir = explicit?.dir ?? IMAGE_TOOL_DEFAULT_DIR;
      const name =
        explicit?.name ?? `${imageSlug(params.prompt, Date.now())}.${imageExtensionFor(result.image.mimeType)}`;
      const uploaded = await options.workspace.uploadFile({
        dir: rootRelativeDir(options.sessionCwd, dir),
        name,
        body: imageBody(result.image),
        signal,
      });
      // 同名はサンドボックスが `-1` を付けて退避するため、実際に保存された名前を返す
      const path = cwdRelativePath(dir, uploaded.name);
      // 使用モデルを結果本文へ残す。投影 (toolResultSummary) は先頭 900 文字で切るため、
      // 長い path でもモデルが欠けないよう先頭の行に置く。会話履歴は session.jsonl の toolResult を正とするため、
      // ここに載せた行が (ライブ / 復元後の両方で) ツール履歴の出力として見える (docs/image-generation.md)
      return {
        content: [
          {
            type: "text",
            text:
              `モデル: ${settings.model}\n` +
              `画像を生成して保存しました: ${path}\n` +
              `本文に示すときは Markdown 画像 ![alt](${path}) で示してください。`,
          },
        ],
        details: undefined,
      };
    },
  };
  return [wrapToolDefinitionWithSecretMasker(definition, options.masker)];
}

/** 未設定・削除後はキー無効エラーにする。作成時のキーは握らず、毎回ここを通す */
function readCurrentSettings(read: () => ImageGenerationSettings | undefined): ImageGenerationSettings {
  let settings: ImageGenerationSettings | undefined;
  try {
    settings = read();
  } catch (error) {
    throw new Error(`画像生成の設定を読み取れませんでした: ${messageFor(error)}`);
  }
  if (!settings) throw new Error("画像APIキーが未設定です。設定 → コンテンツ生成 で画像APIキーを登録してください");
  return settings;
}
