/**
 * BFF ローカルの `generate_image` ツール。サンドボックス実行のリモート定義とは別の層で、
 * `PI_AGENT_TOOLS`（サンドボックスの allowlist）の影響を受けない。
 * 有効化はセッション作成時に固定し、execute は毎回現在の settings を読む（docs/image-generation.md）。
 */
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { messageFor } from "./http";
import { CONTENT_DISABLED_MESSAGE } from "./content-disabled";
import {
  CODEX_AUTH_UNAVAILABLE_MESSAGE,
  CODEX_IMAGE_MODEL_LABEL,
  IMAGE_ABORTED_MESSAGE,
  IMAGE_PARAMETER_NAMES,
  IMAGE_PARAMETER_SEED_MAX,
  declaredImageParameters,
  isUnsaveableOutputOnly,
  normalizeImageParameters,
  saveableImageFormat,
  type CodexAuth,
  type GeneratedImage,
  type ImageGenerationInput,
  type ImageGenerationResult,
  type ImageGenerationSettings,
  type ImageParameterDeclarations,
  type SaveableImageFormat,
} from "./images";
import type { ImageParameterValues } from "./schema";
import {
  imageInputReferenceOf,
  imageInputScopeOf,
  resolveImageInputPath,
  type ImageInputContext,
  type ImageInputTarget,
} from "./image-input";
import type { SandboxWorkspaceClient } from "./sandbox/client";
import { wrapToolDefinitionWithSecretMasker } from "./secret-guard";
import type { SecretMasker } from "./redact";
import { SPEECH_TOOL_NAME } from "./speech-tools";
import { BGM_TOOL_NAME } from "./bgm-tools";
import { cwdRelativePath, parseToolPath, rootRelativeDir } from "./workspace-path";

export const IMAGE_TOOL_NAME = "generate_image";

/** 既定の保存先。`<slug>` はプロンプト、`<ext>` は保存する mimeType から決める */
export const IMAGE_TOOL_DEFAULT_DIR = "generated";
export const IMAGE_TOOL_SLUG_MAX_LENGTH = 40;

export const IMAGE_TOOL_DESCRIPTION =
  "Generate an image from a text prompt, or edit a source image passed in `input_images`, and save the result in the working directory. " +
  "Returns the working-directory-relative path of the saved file. " +
  "Show the generated image in your reply as a Markdown image, for example ![alt](generated/name.png). " +
  "Pass `aspect_ratio`, `resolution`, `quality`, `output_format`, `background` or `seed` only when the user asked for that shape, quality or format.";

export const IMAGE_TOOL_GUIDELINES = [
  "Pass the image parameter arguments (`aspect_ratio` / `resolution` / `quality` / `output_format` / `background` / `seed`) only when the user asked for that shape, quality or format; omit them to keep the model default.",
  "Use generate_image only when the user asks for a new image or an edit of an image they named; it costs provider credits.",
  "For an edit, pass the source image path in `input_images`. Omit it for a new image: the provider then never receives a reference image.",
  "The input image is sent to the external provider unchanged (EXIF included), and the result is a new file: the source file is never overwritten or moved.",
  "If 'this image' could mean several files, ask the user which one instead of guessing, and never send every generated file or every attachment automatically.",
  "After generating, show the saved file as a Markdown image using the working-directory-relative path returned by the tool instead of pasting the path alone.",
];

/**
 * モデルの宣言が引数を許さないときの文言。理由の後ろに課金前であることを添える
 * （宣言の正は `normalizeImageParameters`、こちらはその理由をツールの文言へ包むだけ）。
 */
export function imageParameterRejectedMessage(reason: string): string {
  return `${reason}。生成は行っていません（クレジットは消費していません）`;
}

/** `background: transparent` と jpeg の同時指定を止める文言。jpeg は透明を表現できない */
export const IMAGE_TOOL_TRANSPARENT_JPEG_MESSAGE =
  "background: transparent は保存形式 jpeg と同時に指定できません（生成は行っていません。クレジットは消費していません）。output_format に png か webp を指定してください";

/** 宣言に png / webp が 1 つも無いモデルで `background: transparent` を止める文言 */
export const IMAGE_TOOL_TRANSPARENT_UNSAVEABLE_MESSAGE =
  "この画像モデルは png / webp を宣言していないため、透明な背景の画像を保存できません（生成は行っていません。クレジットは消費していません）。設定 → コンテンツ生成 で別の画像モデルを選んでください";

/** Codex は画像モデルを持たず、引数も受け付けない。黙って捨てずに課金前に止める */
export const CODEX_PARAMETERS_MESSAGE =
  "Codex では画像パラメータ（aspect_ratio / resolution / quality / output_format / background / seed）を指定できません。引数を外して生成してください（画像は生成しておらず、クレジットも消費していません）";

/** パラメータの行が無いときの文言。行の位置を固定するため、未指定でも必ず出す */
export const IMAGE_TOOL_PARAMETER_DEFAULT_LINE = "パラメータ: 指定なし（モデル既定）";

/** 保存できる形式を 1 つも宣言していないモデルを生成前に止めるときの文言。課金前であることを明示する */
export const IMAGE_TOOL_UNSAVEABLE_MODEL_MESSAGE =
  "この画像モデルは png / jpeg / webp を返さないため、生成は行っていません（クレジットは消費していません）。設定 → コンテンツ生成 で別の画像モデルを選んでください";

/**
 * Codex の結果本文のモデル行。画像モデルが返らないため、ルーティングモデルを画像モデルとして出さない。
 * 1 行目を `モデル:` で固定するのは、バッジの読み取り（`generationInfo.ts`）が行の位置に依存するため。
 */
export const CODEX_MODEL_LINE = `モデル: ${CODEX_IMAGE_MODEL_LABEL}`;

/** 生成元が Codex であることを示す行。2 行目（保存パス）の後ろに置く */
export const CODEX_PROVIDER_LINE = "プロバイダー: Codex";

/** Codex は参照画像を受け付けない。読めば課金前に止まるが、読む前に拒否してフォールバックしない */
export const CODEX_INPUT_IMAGES_MESSAGE =
  "Codex は参照画像の編集に対応していません。input_images を外して新規生成してください（画像は生成しておらず、クレジットも消費していません）";

/**
 * Codex の実行時認証を解く。解決できなければ provider を呼ばずに固定文言で止める
 * （解けない理由を「未設定」と推測せず、サインイン案内へ寄せる）。
 */
async function requireCodexAuth(settings: Extract<ImageGenerationSettings, { provider: "codex" }>): Promise<CodexAuth> {
  let auth: CodexAuth | undefined;
  try {
    auth = await settings.resolveAuth();
  } catch {
    // SDK の失敗文言にはトークンが混ざり得る。外へ出すのは固定文言だけにする
    throw new Error(CODEX_AUTH_UNAVAILABLE_MESSAGE);
  }
  if (!auth) throw new Error(CODEX_AUTH_UNAVAILABLE_MESSAGE);
  return auth;
}

/** 有効なときだけ system prompt へ足す。生成物の場所と本文での示し方を固定する */
export const IMAGE_GENERATION_PROMPT_LINES = [
  "generate_image saves generated images under the working directory (by default `generated/`) and returns the working-directory-relative path.",
  "When you generate an image, always show it in your reply as a Markdown image using the actual saved path returned by the tool, for example ![description](generated/name.png), not the requested path or a fixed-name latest copy.",
  "To edit an existing image, pass its path (working-directory-relative, or the absolute path under `<attached_files>` for an attachment) as `input_images`. The tool reads the file itself, so never paste image data into the tool arguments.",
  "An edit is a new file produced from the source image: the source is never overwritten, and the result may not preserve pixels you did not ask to change.",
  "Input images are sent to the external image provider unchanged, including embedded metadata. Only send an image the user asked to edit.",
  "Do not overwrite existing generated files; keep each unique saved file unchanged so past conversation images remain intact.",
  "If a fixed-name latest copy is needed, use `cp` to a separate path while keeping the unique generated file. Never use `mv` to move a file referenced by the conversation.",
];

export function sessionToolNames(
  base: readonly string[],
  enabled: { image: boolean; speech: boolean; bgm?: boolean },
): string[] {
  return [
    ...base,
    ...(enabled.image ? [IMAGE_TOOL_NAME] : []),
    ...(enabled.speech ? [SPEECH_TOOL_NAME] : []),
    ...(enabled.bgm ? [BGM_TOOL_NAME] : []),
  ];
}

const generateImageSchema = Type.Object({
  prompt: Type.String({ description: "Text prompt describing the image to generate or the change to make" }),
  path: Type.Optional(
    Type.String({
      description:
        "Optional path relative to the working directory (for example `generated/cafe.png`). Parent directories are created. Existing files are not overwritten; the new file gets a suffix such as `-1` if the name is taken. Always use the actual saved path returned by the tool in your reply, and keep that unique file unchanged. If a fixed-name latest copy is needed, use `cp` to a separate path while retaining the generated file; never `mv` a file referenced by the conversation.",
    }),
  ),
  input_images: Type.Optional(
    Type.Array(
      Type.String({
        description:
          "Source image to edit, as a working-directory-relative path (for example `generated/portrait.png`) or the absolute path of an attachment of this conversation. PNG / JPEG / WebP up to 10 MiB and 40 megapixels; at most one image. The provider receives the bytes and the result is saved as a new file, so the source is unchanged. Omit it for a brand-new image.",
      }),
      { minItems: 1, maxItems: 1 },
    ),
  ),
  aspect_ratio: Type.Optional(
    Type.String({
      description:
        "Optional aspect ratio declared by the selected image model (for example `16:9`). Set it only when the user asked for that shape; the value must be one the model declares.",
    }),
  ),
  resolution: Type.Optional(
    Type.String({
      description:
        "Optional resolution declared by the selected image model (whatever the model names, for example `1K`). Set it only when the user asked for that size; the value must be one the model declares.",
    }),
  ),
  quality: Type.Optional(
    Type.String({
      description:
        "Optional quality declared by the selected image model (for example `high`). Set it only when the user asked for that quality; the value must be one the model declares.",
    }),
  ),
  output_format: Type.Optional(
    Type.String({
      description:
        "Optional output format the selected image model declares and the app can save (`png` / `jpeg` / `webp`). Set it only when the user asked for that format.",
    }),
  ),
  background: Type.Optional(
    Type.String({
      description:
        "Optional background declared by the selected image model (for example `transparent`). `transparent` cannot be combined with the `jpeg` output format and needs a model that declares png or webp.",
    }),
  ),
  seed: Type.Optional(
    Type.Number({
      description:
        "Optional seed for a model that declares it: an integer from 0 to 2147483647. Set it only when the user asked to reproduce or vary a result.",
    }),
  ),
});
type GenerateImageParams = Static<typeof generateImageSchema>;

/** 参照画像は MVP で 1 枚だけ。配列形は複数参照に備えて受け付けるが、枚数はここで課金前に止める */
export const IMAGE_TOOL_MAX_INPUT_IMAGES = 1;

export const IMAGE_TOOL_EMPTY_INPUT_MESSAGE = "input_images が空です（新規生成なら省略してください）";
export const IMAGE_TOOL_MULTIPLE_INPUT_MESSAGE =
  "input_images に指定できるのは 1 枚だけです（複数の参照画像は未対応です）。課金は発生していません";

/** 参照画像の要求パスを課金前に検証する。サンドボックスへは解決後の root 相対パスだけを渡す */
function resolveImageInputTargets(
  inputImages: readonly string[] | undefined,
  options: ImageToolDefinitionOptions,
): ImageInputTarget[] {
  if (inputImages === undefined) return [];
  if (inputImages.length === 0) throw new Error(IMAGE_TOOL_EMPTY_INPUT_MESSAGE);
  if (inputImages.length > IMAGE_TOOL_MAX_INPUT_IMAGES) throw new Error(IMAGE_TOOL_MULTIPLE_INPUT_MESSAGE);
  const context: ImageInputContext = {
    sessionCwd: options.sessionCwd,
    rootCwd: options.rootCwd,
    uploadsDirRel: options.uploadsDirRel,
  };
  return inputImages.map((path) => resolveImageInputPath(path, context));
}

/** 引数で明示された値だけを集める。省略したキーは送らず、provider の既定に任せる */
function explicitImageParameters(params: GenerateImageParams): ImageParameterValues | undefined {
  const values: ImageParameterValues = {
    ...(params.aspect_ratio === undefined ? {} : { aspect_ratio: params.aspect_ratio }),
    ...(params.resolution === undefined ? {} : { resolution: params.resolution }),
    ...(params.quality === undefined ? {} : { quality: params.quality }),
    ...(params.output_format === undefined ? {} : { output_format: params.output_format }),
    ...(params.background === undefined ? {} : { background: params.background }),
    ...(params.seed === undefined ? {} : { seed: params.seed }),
  };
  return IMAGE_PARAMETER_NAMES.some((name) => values[name] !== undefined) ? values : undefined;
}

/**
 * 引数の値と、保存済みの既定をキー単位で合成する（明示引数 > 既定）。既定はモデルの宣言に収まるキー
 * だけを残し、宣言が読めないモデルでは 1 つも使わない。既定を勝手に送ると、要求と実際の生成が
 * 食い違ったまま履歴に残る。
 */
function mergedImageParameters(
  declared: ImageParameterDeclarations | undefined,
  explicit: ImageParameterValues | undefined,
  defaults: ImageParameterValues | undefined,
): ImageParameterValues {
  return { ...declaredImageParameters(declared, defaults), ...explicit };
}

/**
 * 引数をモデル宣言と突き合わせ、送る値を決める。宣言の外は理由付きで止める（宣言が無いモデルへ
 * 値を送ると、要求と実際の生成が食い違ったまま履歴に残る）。
 */
function effectiveImageParameters(
  declared: ImageParameterDeclarations | undefined,
  explicit: ImageParameterValues | undefined,
): ImageParameterValues {
  // 宣言が `boolean`（受け付けるの意味）でも seed の型契約は崩さない
  if (
    explicit?.seed !== undefined &&
    (!Number.isInteger(explicit.seed) || explicit.seed < 0 || explicit.seed > IMAGE_PARAMETER_SEED_MAX)
  ) {
    throw new Error(imageParameterRejectedMessage(`seed に指定できない値です: ${String(explicit.seed)}`));
  }
  const validated = normalizeImageParameters(declared, explicit);
  if (!validated.ok) throw new Error(imageParameterRejectedMessage(validated.message));
  return validated.values;
}

/**
 * `background: transparent` を保存できるか。jpeg は透明を表現できず、宣言に png / webp が 1 つも無い
 * モデルでは透明な結果を保存できない（宣言が読めないときだけ通す）。
 */
function transparentRejection(
  values: ImageParameterValues,
  declaredFormats: readonly string[] | undefined,
): string | undefined {
  if (values.background !== "transparent") return undefined;
  if (values.output_format !== undefined) {
    return saveableImageFormat(values.output_format) === "jpeg" ? IMAGE_TOOL_TRANSPARENT_JPEG_MESSAGE : undefined;
  }
  if (!declaredFormats || declaredFormats.length === 0) return undefined;
  const keepsAlpha = declaredFormats.some((format) => {
    const saveable = saveableImageFormat(format);
    return saveable === "png" || saveable === "webp";
  });
  return keepsAlpha ? undefined : IMAGE_TOOL_TRANSPARENT_UNSAVEABLE_MESSAGE;
}

/** 3 行目に置くパラメータ行。未指定でも行を出して位置を固定する */
function imageParameterLine(values: ImageParameterValues): string {
  const pairs: string[] = [];
  for (const name of IMAGE_PARAMETER_NAMES) {
    const value = values[name];
    if (value !== undefined) pairs.push(`${name}=${String(value)}`);
  }
  return pairs.length === 0 ? IMAGE_TOOL_PARAMETER_DEFAULT_LINE : `パラメータ: ${pairs.join(", ")}`;
}

/**
 * 参照画像をサンドボックスから取得し、BFF 側でも形式・上限を検証してから data URL にする。
 * 読めないときに参照なしの生成へ黙ってフォールバックしない（課金理由を勝手に変えない）。
 */
async function readImageInputReferences(
  targets: readonly ImageInputTarget[],
  options: ImageToolDefinitionOptions,
  signal?: AbortSignal | undefined,
): Promise<{ mimeType: string; dataUrl: string }[]> {
  if (targets.length === 0) return [];
  const scope = imageInputScopeOf({
    sessionCwd: options.sessionCwd,
    rootCwd: options.rootCwd,
    uploadsDirRel: options.uploadsDirRel,
  });
  const references: { mimeType: string; dataUrl: string }[] = [];
  for (const target of targets) {
    let bytes: Uint8Array;
    try {
      bytes = await options.readImageInput(target.rootRelative, scope, signal);
    } catch (error) {
      // 中断はサンドボックス側の生文言ではなく、画像生成の中断として返す
      if (signal?.aborted) throw new Error(IMAGE_ABORTED_MESSAGE);
      throw error;
    }
    if (signal?.aborted) throw new Error(IMAGE_ABORTED_MESSAGE);
    references.push(imageInputReferenceOf(bytes, target));
  }
  return references;
}

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
  /** ワークスペース root の絶対パス。参照画像の絶対パスを範囲内か判定するのに使う */
  rootCwd: string;
  /** この会話の添付置き場（root 相対）。所属スペースで変わる。参照画像の絶対パスの許可範囲に使う */
  uploadsDirRel: string | undefined;
  workspace: SandboxWorkspaceClient;
  masker: SecretMasker;
  /** 実行のたびに読む。未設定・削除後は undefined（キー無効エラー） */
  readSettings: () => ImageGenerationSettings | undefined;
  /**
   * 実行のたびに読む有効 / 無効。OFF は provider を叩く前に固定文言で止める（セッション作成時に
   * 凍結しないので、既存の会話にも次の呼び出しから効く）。省くと常に有効
   */
  readEnabled?: () => boolean;
  /** 実行のたびに読むカタログの形式宣言。未知名・宣言なしは undefined（＝止めない） */
  readOutputFormats: (model: string) => readonly string[] | undefined;
  /** 実行のたびに読むカタログのパラメータ宣言。未知名・宣言なしは undefined（＝不明） */
  readParameters: (model: string) => ImageParameterDeclarations | undefined;
  /**
   * 参照画像の編集が可能かを課金前に確かめる。可なら undefined、止めるときは理由の文言。
   * 新規生成（`input_images` 省略時）は呼ばない。
   */
  checkImageInput: (model: string, signal?: AbortSignal | undefined) => Promise<string | undefined>;
  /** サンドボックスから参照画像のバイトを取る。scope は BFF が決めた root 相対の許可範囲 */
  readImageInput: (path: string, scope: readonly string[], signal?: AbortSignal | undefined) => Promise<Uint8Array>;
  /**
   * 生成元を決めて 1 回だけ生成する。`apiKey` は OpenRouter のときだけ、Codex は解決済みの認証を渡す
   * （ツール側で provider の分岐を持たない）。
   */
  generate: (input: ImageGenerationInput) => Promise<ImageGenerationResult>;
}

export function createImageToolDefinitions(options: ImageToolDefinitionOptions): ToolDefinition[] {
  if (!options.enabled) return [];
  const definition: ToolDefinition<typeof generateImageSchema> = {
    name: IMAGE_TOOL_NAME,
    label: IMAGE_TOOL_NAME,
    description: IMAGE_TOOL_DESCRIPTION,
    promptSnippet: "Generate or edit an image from a prompt",
    promptGuidelines: [...IMAGE_TOOL_GUIDELINES],
    parameters: generateImageSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params: GenerateImageParams, signal) {
      // 判定を execute まで遅らせないと、OFF が既存セッションの次の呼び出しに効かない
      if (!(options.readEnabled?.() ?? true)) throw new Error(CONTENT_DISABLED_MESSAGE);
      // 支出の前に path・参照画像・形式を検証する。dir と name は実際に保存するまで確定しない
      const explicit = params.path === undefined ? undefined : parseToolPath(params.path);
      const targets = resolveImageInputTargets(params.input_images, options);
      const settings = readCurrentSettings(options.readSettings);
      // Codex は参照画像を送れない。サンドボックスから読む前に拒否し、参照なしの生成へ黙って変えない
      if (settings.provider === "codex" && targets.length > 0) throw new Error(CODEX_INPUT_IMAGES_MESSAGE);
      const requested = explicitImageParameters(params);
      // Codex は画像モデルを持たず引数も受け付けない。黙って捨てると結果本文と実際の要求が食い違う
      if (settings.provider === "codex" && requested !== undefined) throw new Error(CODEX_PARAMETERS_MESSAGE);
      // 宣言と既定は OpenRouter のときだけ引く。Codex は既定を 1 つも持たない（同じ map を混ぜない）
      const declared = settings.provider === "openrouter" ? options.readParameters(settings.model) : undefined;
      const defaults = settings.provider === "openrouter" ? settings.parameters : undefined;
      const parameters = effectiveImageParameters(declared, mergedImageParameters(declared, requested, defaults));
      // 保存名を決める段で初めて分かると生成だけが成功して課金が残るため、provider を叩く前に止める。
      // Codex は画像モデルを選ばず、返る形式も宣言しない（保存の可否は応答の形式で決まる）
      if (settings.provider === "openrouter" && isUnsaveableOutputOnly(options.readOutputFormats(settings.model))) {
        throw new Error(IMAGE_TOOL_UNSAVEABLE_MODEL_MESSAGE);
      }
      if (settings.provider === "openrouter" && parameters.background === "transparent") {
        const rejection = transparentRejection(parameters, options.readOutputFormats(settings.model));
        if (rejection !== undefined) throw new Error(rejection);
      }
      const references = await readImageInputReferences(targets, options, signal);
      if (references.length > 0 && settings.provider === "openrouter") {
        // 参照を使う編集は、モデル宣言と endpoint 宣言の両方を課金前に確かめる
        const reason = await options.checkImageInput(settings.model, signal);
        if (reason !== undefined) throw new Error(reason);
      }
      const inputReferences = references.map((reference) => reference.dataUrl);
      const parameterInput = Object.keys(parameters).length > 0 ? { parameters } : {};
      const result =
        settings.provider === "codex"
          ? await options.generate({
              provider: "codex",
              auth: await requireCodexAuth(settings),
              prompt: params.prompt,
              ...parameterInput,
              signal,
            })
          : await options.generate({
              provider: "openrouter",
              model: settings.model,
              prompt: params.prompt,
              apiKey: settings.apiKey,
              ...parameterInput,
              signal,
              ...(references.length > 0 ? { inputReferences } : {}),
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
      // Codex は画像モデルを知らないので、ルーティングモデルを出さずに固定の表示名と生成元を書く。
      // パラメータ行は 3 行目（index 2）に固定し、未指定でも行を出す（`generationInfo.ts` の読み取り位置を動かさない）
      const parameterLine = imageParameterLine(parameters);
      const header =
        settings.provider === "codex"
          ? `${CODEX_MODEL_LINE}\n画像を生成して保存しました: ${path}\n${parameterLine}\n${CODEX_PROVIDER_LINE}`
          : `モデル: ${settings.model}\n画像を生成して保存しました: ${path}\n${parameterLine}`;
      return {
        content: [
          {
            type: "text",
            text:
              `${header}\n` +
              `本文に示すときは Markdown 画像 ![alt](${path}) で示してください。` +
              // 編集元は保存パス行より後に置き、投影の切詰めでモデル行・保存パス行が落ちない位置を守る
              (references.length > 0 ? `\n編集元: ${targets.map((target) => target.display).join(", ")}` : ""),
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
