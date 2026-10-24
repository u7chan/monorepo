import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  bgmAbortable,
  BGM_MAX_CONCURRENT,
  BGM_MODEL,
  BGM_PATH_MAX_LENGTH,
  BGM_PROMPT_MAX_LENGTH,
  BGM_TIMEOUT_MS,
  type BgmGenerationInput,
  type BgmGenerationSettings,
} from "./bgm";
import { CONTENT_DISABLED_MESSAGE } from "./content-disabled";
import type { SandboxWorkspaceClient } from "./sandbox/client";
import { wrapToolDefinitionWithSecretMasker } from "./secret-guard";
import type { SecretMasker } from "./redact";
import { cwdRelativePath, parseToolPath, rootRelativeDir } from "./workspace-path";

export const BGM_TOOL_NAME = "generate_bgm";
export const BGM_GENERATION_PROMPT_LINES = [
  "Use generate_bgm only for an explicit request to generate NEW instrumental background music; use generate_speech for verbatim TTS, not music.",
  "BGM generation costs credits. Never call it to play, seek, replay or reuse an existing audio file.",
  "It saves one MP3 under the working directory (default generated/); show the actual saved path returned by the tool. Never overwrite, move or delete the unique generated file.",
  "No guaranteed BPM, exact duration, seamless loop or absence of vocals. If generation fails after sending, credits may have been charged; never regenerate without the user's explicit new request.",
];

const schema = Type.Object(
  {
    prompt: Type.String({
      minLength: 1,
      maxLength: BGM_PROMPT_MAX_LENGTH,
      description: "Describe new instrumental background music, not words to read aloud.",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "Optional cwd-relative MP3 path; defaults to generated/bgm-<slug or timestamp>.mp3. Extension is added if omitted; parent directories are created and existing files are never overwritten. Use the actual saved path returned.",
      }),
    ),
  },
  { additionalProperties: false },
);

let activeBgm = 0;

export interface BgmToolDefinitionOptions {
  enabled: boolean;
  sessionCwd: string;
  workspace: SandboxWorkspaceClient;
  masker: SecretMasker;
  readSettings: () => BgmGenerationSettings | undefined;
  /**
   * 実行のたびに読む有効 / 無効。OFF は provider を叩く前に固定文言で止める（セッション作成時に
   * 凍結しないので、既存の会話にも次の呼び出しから効く）。省くと常に有効
   */
  readEnabled?: () => boolean;
  generate: (input: BgmGenerationInput) => Promise<Uint8Array<ArrayBuffer>>;
  timeoutMs?: number;
}

export function bgmTarget(path: string) {
  if (/[\s\p{Cc}]/u.test(path)) throw new Error("BGMのpathに空白・制御文字は使えません");
  const target = parseToolPath(path);
  if (target.name.startsWith(".")) throw new Error("BGMのファイル名は . で始められません");
  if (!target.name.includes(".")) target.name += ".mp3";
  else if (!target.name.toLowerCase().endsWith(".mp3")) throw new Error("BGMの保存拡張子は .mp3 だけです");
  if (path.length + (path.split("/").at(-1)!.includes(".") ? 0 : 4) > BGM_PATH_MAX_LENGTH)
    throw new Error("BGMのpathが長すぎます");
  return target;
}

function defaultPath(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `generated/bgm-${slug || new Date().toISOString().replace(/[:.]/g, "-")}.mp3`;
}

export function createBgmToolDefinitions(options: BgmToolDefinitionOptions): ToolDefinition[] {
  if (!options.enabled) return [];
  const definition: ToolDefinition<typeof schema> = {
    name: BGM_TOOL_NAME,
    label: BGM_TOOL_NAME,
    description:
      "Generate one new instrumental BGM clip as MP3 and save it without overwriting existing files. Not TTS or audio playback. Costs provider credits; no automatic retry.",
    promptSnippet: "Generate new instrumental background music",
    promptGuidelines: [...BGM_GENERATION_PROMPT_LINES],
    parameters: schema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_id, params: Static<typeof schema>, signal) {
      // 判定を execute まで遅らせないと、OFF が既存セッションの次の呼び出しに効かない
      if (!(options.readEnabled?.() ?? true)) throw new Error(CONTENT_DISABLED_MESSAGE);
      if (
        typeof params.prompt !== "string" ||
        params.prompt.trim() === "" ||
        params.prompt.length > BGM_PROMPT_MAX_LENGTH
      )
        throw new Error("BGMのpromptは空白以外を含む1,000文字以内で指定してください（API未送信）");
      if (
        Object.keys(params).some((key) => key !== "prompt" && key !== "path") ||
        (params.path !== undefined && typeof params.path !== "string")
      )
        throw new Error("BGMの引数はpromptとpathだけです（API未送信）");
      let target;
      try {
        target = bgmTarget(params.path ?? defaultPath(params.prompt));
      } catch {
        throw new Error(
          "BGMのpathが不正です。cwd相対・800文字以内・空白なしのMP3ファイル名を指定してください（API未送信）",
        );
      }
      const settings = options.readSettings();
      if (!settings?.apiKey)
        throw new Error("BGM用の共有APIキーが未設定です。設定 → コンテンツ生成で登録してください（API未送信）");
      if (signal?.aborted) throw new Error("BGM生成を中断しました（API未送信）");
      if (activeBgm >= BGM_MAX_CONCURRENT) throw new Error("BGMは同時に2件までです（API未送信）");
      activeBgm += 1;
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? BGM_TIMEOUT_MS;
      const deadline = performance.now() + timeoutMs;
      const onAbort = () => controller.abort(new Error("BGM生成を中断しました"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timer = setTimeout(() => controller.abort(new Error("BGM生成・保存がタイムアウトしました")), timeoutMs);
      const checkDeadline = () => {
        if (performance.now() >= deadline) controller.abort(new Error("BGM生成・保存がタイムアウトしました"));
        controller.signal.throwIfAborted();
      };
      let saving = false;
      try {
        checkDeadline();
        const bytes = await bgmAbortable(
          options.generate({ prompt: params.prompt, apiKey: settings.apiKey, signal: controller.signal }),
          controller.signal,
        );
        checkDeadline();
        saving = true;
        const uploaded = await bgmAbortable(
          options.workspace.uploadFile({
            dir: rootRelativeDir(options.sessionCwd, target.dir),
            name: target.name,
            body: new Blob([bytes]).stream(),
            signal: controller.signal,
          }),
          controller.signal,
        );
        checkDeadline();
        const path = cwdRelativePath(target.dir, uploaded.name);
        return {
          content: [
            {
              type: "text",
              text: `モデル: ${BGM_MODEL}\nBGMを生成して保存しました: ${path}\n形式: MP3\n本文には、この実保存パスを示してください。`,
            },
          ],
          details: undefined,
        };
      } catch (error) {
        const message = options.masker.mask(error instanceof Error ? error.message : "不明なエラー").slice(0, 500);
        throw new Error(
          `${saving ? "生成後の保存に失敗しました" : "BGM生成に失敗しました"}: ${message}。課金されている可能性があります。明示的な再依頼なしに再生成しないでください。`,
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        controller.abort();
        activeBgm -= 1;
      }
    },
  };
  return [wrapToolDefinitionWithSecretMasker(definition, options.masker)];
}
