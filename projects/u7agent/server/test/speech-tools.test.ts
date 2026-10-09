// generate_speech ツールの組み立てと保存規則。実 API もサンドボックスも使わず、fake workspace / stub generator で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { IMAGE_TOOL_NAME, sessionToolNames } from "../src/image-tools";
import { createMutableSecretMasker } from "../src/redact";
import type { SandboxUploadInput, SandboxWorkspaceClient } from "../src/sandbox/client";
import { toolResultSummary } from "../src/session-projection";
import type { SpeechGenerationSettings } from "../src/speech";
import {
  assertSpeechFileName,
  createSpeechToolDefinitions,
  pcmToWav,
  SPEECH_GENERATION_PROMPT_LINES,
  SPEECH_TOOL_EXTENSION_MESSAGE,
  SPEECH_TOOL_KEY_UNSET_MESSAGE,
  SPEECH_TOOL_NAME,
  SPEECH_TOOL_TEXT_MAX_LENGTH,
  SPEECH_TOOL_TEXT_TOO_LONG_MESSAGE,
  SPEECH_TOOL_VOICE_MESSAGE,
  speechFileName,
  speechSlug,
} from "../src/speech-tools";

type AnyTool = ToolDefinition<any, any, any>;

interface Capture {
  uploads: SandboxUploadInput[];
  /** アップロード本文を読んだ結果 */
  bodies: Buffer[];
  generated: {
    provider: string;
    model: string;
    text: string;
    voice?: string | undefined;
    apiKey: string;
    signal?: AbortSignal | undefined;
  }[];
}

function fakeWorkspace(
  capture: Capture,
  result: (input: SandboxUploadInput) => { path: string; name: string; renamed: boolean; size: number } = (input) => ({
    path: input.dir ? `${input.dir}/${input.name}` : input.name,
    name: input.name,
    renamed: false,
    size: 0,
  }),
): SandboxWorkspaceClient {
  return {
    uploadFile: async (input: SandboxUploadInput) => {
      capture.uploads.push(input);
      capture.bodies.push(input.body ? Buffer.from(await new Response(input.body).arrayBuffer()) : Buffer.alloc(0));
      return result(input);
    },
  } as unknown as SandboxWorkspaceClient;
}

const AUDIO = [0x49, 0x44, 0x33, 0x04];

function tool(options: {
  enabled?: boolean;
  sessionCwd?: string;
  capture: Capture;
  masker?: ReturnType<typeof createMutableSecretMasker>;
  settings?: SpeechGenerationSettings | undefined | (() => SpeechGenerationSettings | undefined);
  voices?: (model: string) => readonly string[] | undefined;
  generate?: (input: Capture["generated"][number]) => Promise<unknown>;
  workspaceResult?: (input: SandboxUploadInput) => { path: string; name: string; renamed: boolean; size: number };
}): AnyTool {
  const settingsOption = options.settings;
  const definitions = createSpeechToolDefinitions({
    enabled: options.enabled ?? true,
    sessionCwd: options.sessionCwd ?? "",
    workspace: fakeWorkspace(options.capture, options.workspaceResult),
    masker: options.masker ?? createMutableSecretMasker([]),
    readSettings: () => (typeof settingsOption === "function" ? settingsOption() : settingsOption),
    readVoices: options.voices ?? (() => undefined),
    generate: async (input) => {
      options.capture.generated.push(input);
      if (options.generate) return (await options.generate(input)) as never;
      return { ok: true, speech: { audio: new Uint8Array(AUDIO).buffer, format: "mp3", contentType: "audio/mpeg" } };
    },
  });
  assert.equal(definitions.length, 1);
  return definitions[0];
}

async function run(tool: AnyTool, params: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const result = (await tool.execute("call-1", params, signal, undefined, {} as never)) as {
    content: { type: string; text?: string }[];
  };
  const text = result.content[0]?.text;
  assert.equal(typeof text, "string");
  return text as string;
}

const settings: SpeechGenerationSettings = {
  provider: "openrouter",
  model: "google/gemini-3.8-flash-tts",
  voice: "Zephyr",
  apiKey: "sk-speech-dummy-key",
};

test("課金前の検証は .mp3 / .wav だけを許し、他の拡張子は拒否する", () => {
  for (const name of ["narration.mp3", "narration.MP3", "narration.wav", "narration.WAV", "narration"]) {
    assert.doesNotThrow(() => assertSpeechFileName(name), name);
  }
  // 解釈の分かれる名前（バージョン付き・他の拡張子）は推測せず拒否する
  for (const bad of ["narration.pcm", "archive.mp3.zip", "v1.2", "narration."]) {
    assert.throws(() => assertSpeechFileName(bad), new Error(SPEECH_TOOL_EXTENSION_MESSAGE), bad);
  }
});

test("保存名の拡張子は要求ではなく実形式へ寄せる", () => {
  assert.equal(speechFileName("narration.mp3", "mp3"), "narration.mp3");
  assert.equal(speechFileName("narration.wav", "mp3"), "narration.mp3");
  assert.equal(speechFileName("narration.MP3", "pcm"), "narration.wav");
  assert.equal(speechFileName("hero.MP3", "pcm"), "hero.wav");
  assert.equal(speechFileName("narration", "mp3"), "narration.mp3");
  assert.equal(speechFileName("2026-09-28T12-34-56-000Z", "pcm"), "2026-09-28T12-34-56-000Z.wav");
});

test("pcm は 44 バイトの RIFF ヘッダを付けて WAV にする", () => {
  const wav = pcmToWav(new Uint8Array([1, 2, 3, 4]).buffer, 24000, 1);
  assert.equal(wav.byteLength, 48, "44 バイトのヘッダ + データ");
  const view = new DataView(wav);
  const ascii = (offset: number, length: number): string => String.fromCharCode(...new Uint8Array(wav, offset, length));
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), 40, "RIFF チャンク = ヘッダ 36 + データ");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(ascii(12, 4), "fmt ");
  assert.equal(view.getUint32(16, true), 16, "fmt チャンク");
  assert.equal(view.getUint16(20, true), 1, "PCM");
  assert.equal(view.getUint16(22, true), 1, "channels");
  assert.equal(view.getUint32(24, true), 24000, "sampleRate");
  assert.equal(view.getUint32(28, true), 48000, "byteRate = rate * channels * 2");
  assert.equal(view.getUint16(32, true), 2, "blockAlign = channels * 2");
  assert.equal(view.getUint16(34, true), 16, "bitsPerSample");
  assert.equal(ascii(36, 4), "data");
  assert.equal(view.getUint32(40, true), 4);
  assert.deepEqual([...new Uint8Array(wav, 44)], [1, 2, 3, 4]);
});

test("slug は [a-z0-9-] へ正規化して 40 文字まで、取れなければ日時", () => {
  assert.equal(speechSlug("A Cafe in Kyoto!", 0), "a-cafe-in-kyoto");
  assert.equal(speechSlug("x".repeat(60), 0), "x".repeat(40));
  assert.equal(
    speechSlug("日本語のナレーション", Date.parse("2026-09-28T12:34:56.000Z")),
    "speech-2026-09-28T12-34-56-000Z",
  );
});

test("ツール一覧は有効なときだけ generate_speech を足し、画像とは独立に切り替えられる", () => {
  assert.deepEqual(sessionToolNames(["read"], { image: false, speech: true }), ["read", SPEECH_TOOL_NAME]);
  assert.deepEqual(sessionToolNames(["read"], { image: true, speech: true }), [
    "read",
    IMAGE_TOOL_NAME,
    SPEECH_TOOL_NAME,
  ]);
  assert.deepEqual(
    createSpeechToolDefinitions({
      enabled: false,
      sessionCwd: "",
      workspace: {} as SandboxWorkspaceClient,
      masker: createMutableSecretMasker([]),
      readSettings: () => undefined,
      readVoices: () => undefined,
      generate: async () => ({ ok: false, code: "unknown", message: "x" }),
    }),
    [],
  );
});

test("引数は text / voice / path だけで、演技指示を書かないことを説明に含める", () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const definition = tool({ capture, settings });
  assert.deepEqual(Object.keys(definition.parameters.properties), ["text", "voice", "path"], "引数は増やさない");
  const description = definition.parameters.properties.text.description;
  assert.equal(typeof description, "string");
  assert.match(description, /verbatim/);
  assert.match(description, /acting directions/);
  const pathDescription = definition.parameters.properties.path.description;
  assert.match(pathDescription, /\.mp3/);
  assert.match(pathDescription, /actual saved path returned by the tool/);
  assert.match(SPEECH_GENERATION_PROMPT_LINES.join("\n"), /multiple times with separate parts/);
  assert.match(SPEECH_GENERATION_PROMPT_LINES.join("\n"), /concatenating them is out of scope/);
});

test("省略時は generated/<slug>.mp3 へ保存し、モデル / ボイス / 実際のパスを結果の先頭に置く", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const text = await run(tool({ capture, settings, sessionCwd: "projects/u7agent" }), { text: "A Cafe in Kyoto!" });
  assert.equal(capture.uploads.length, 1);
  assert.equal(capture.uploads[0].dir, "projects/u7agent/generated");
  assert.match(capture.uploads[0].name, /^a-cafe-in-kyoto[a-z0-9-]*\.mp3$/);
  assert.deepEqual(capture.bodies[0], Buffer.from(AUDIO), "応答の生バイトをそのまま保存する");
  assert.equal(capture.generated[0]?.voice, "Zephyr", "設定のボイスを送る");
  assert.ok(text.startsWith("モデル: google/gemini-3.8-flash-tts\nボイス: Zephyr\n"), text);
  assert.ok(text.includes("generated/"), text);
  assert.ok(!text.includes("projects/u7agent/generated/"), "root 相対を返している");
  assert.match(text, /[a-z0-9-]+\.mp3/);
});

test("voice 引数は設定を上書きし、モデルが宣言しない値は課金前に拒否する", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const execute = tool({
    capture,
    settings,
    voices: (model) => (model === settings.model ? ["Zephyr", "Kore"] : undefined),
  });
  await run(execute, { text: "hello", voice: "Kore" });
  assert.equal(capture.generated[0]?.voice, "Kore");
  assert.equal(capture.uploads.length, 1);

  await assert.rejects(() => run(execute, { text: "hello", voice: "Ghost" }), new Error(SPEECH_TOOL_VOICE_MESSAGE));
  assert.equal(capture.generated.length, 1, "宣言外の声で provider を呼んでいる");
});

test("宣言が無いモデルは自由記述の声を許し、空なら voice を送らない", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const free = tool({
    capture,
    settings: { ...settings, model: "fish/audio", voice: "" },
    voices: () => undefined,
  });
  const text = await run(free, { text: "hello", voice: "any-voice-id" });
  assert.equal(capture.generated[0]?.voice, "any-voice-id");
  assert.ok(text.includes("ボイス: any-voice-id"));

  const none = tool({ capture, settings: { ...settings, model: "fish/audio", voice: "" }, voices: () => undefined });
  const noVoice = await run(none, { text: "hello" });
  assert.equal(capture.generated[1]?.voice, "", "送らないことを空文字で表す");
  assert.ok(noVoice.includes("ボイス: （モデル既定）"), noVoice);
});

test("path を明示しても保存名の拡張子は実形式へ寄せ、他の拡張子は課金前に拒否する", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const execute = tool({ capture, settings });
  const text = await run(execute, { text: "hello", path: "assets/hero.mp3" });
  assert.equal(capture.uploads[0].dir, "assets");
  assert.equal(capture.uploads[0].name, "hero.mp3");
  assert.ok(text.includes("assets/hero.mp3"));

  await run(execute, { text: "hello", path: "assets/narration" });
  assert.equal(capture.uploads[1].name, "narration.mp3");

  await run(execute, { text: "hello", path: "assets/hero.wav" });
  assert.equal(capture.uploads[2].name, "hero.mp3", "返った実形式が mp3 なのに .wav の名前で保存している");

  for (const path of ["assets/narration.pcm", "assets/narration.ogg"]) {
    await assert.rejects(() => run(execute, { text: "hello", path }), new Error(SPEECH_TOOL_EXTENSION_MESSAGE));
  }
  assert.equal(capture.generated.length, 3, "拒否した呼び出しで provider を呼んでいる");
});

test(".mp3 を要求しても pcm が返れば .wav へ WAV 化して保存する", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const execute = tool({
    capture,
    settings,
    generate: async () => ({
      ok: true,
      speech: {
        audio: new Uint8Array([1, 2, 3, 4]).buffer,
        format: "pcm",
        contentType: "audio/pcm",
        sampleRate: 24000,
        channels: 1,
      },
    }),
  });
  const text = await run(execute, { text: "hello", path: "assets/hero.MP3" });
  assert.equal(capture.uploads[0].name, "hero.wav");
  assert.ok(text.includes("assets/hero.wav"), text);
  const body = capture.bodies[0];
  assert.equal(body.byteLength, 48);
  assert.equal(body.subarray(0, 4).toString("ascii"), "RIFF");
  assert.deepEqual([...body.subarray(44)], [1, 2, 3, 4], "ヘッダの後ろに pcm の生バイトを置く");
});

test("path を省略したときも実形式の拡張子で保存する", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const execute = tool({
    capture,
    settings,
    generate: async () => ({
      ok: true,
      speech: {
        audio: new Uint8Array([1, 2]).buffer,
        format: "pcm",
        contentType: "audio/pcm",
        sampleRate: 44100,
        channels: 2,
      },
    }),
  });
  const text = await run(execute, { text: "A Cafe in Kyoto!" });
  assert.equal(capture.uploads[0].dir, "generated");
  assert.match(capture.uploads[0].name, /^a-cafe-in-kyoto[a-z0-9-]*\.wav$/);
  assert.ok(text.includes(".wav"), text);
});

test("同名衝突ではサンドボックスが返した実際の名前を結果に載せる", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const text = await run(
    tool({
      capture,
      settings,
      workspaceResult: (input) => ({
        path: input.dir ? `${input.dir}/${input.name}` : input.name,
        name: "a-cafe-1.mp3",
        renamed: true,
        size: 0,
      }),
    }),
    { text: "a cafe" },
  );
  assert.ok(text.includes("generated/a-cafe-1.mp3"), text);
  assert.ok(!text.includes("generated/a-cafe.mp3"), "要求した元のパスを本文に使わせない");
});

test("長い path でもモデル / ボイスは投影の切詰め内に残る", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  // 投影 (SUMMARY_TEXT_MAX = 900) より長い path。basename は有効なまま
  const longDir = Array.from({ length: 5 }, () => "d".repeat(180)).join("/");
  const text = await run(tool({ capture, settings }), { text: "hello", path: `${longDir}/narration.mp3` });
  const projected = toolResultSummary({ content: [{ type: "text", text }] }, createMutableSecretMasker([]));
  assert.ok(projected.startsWith("モデル: google/gemini-3.8-flash-tts\nボイス: Zephyr\n"), projected.slice(0, 120));
});

test("課金前に止める失敗は provider を呼ばず、固定文言を返す", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const execute = tool({ capture, settings, voices: () => ["Zephyr"] });

  await assert.rejects(
    () => run(execute, { text: "x".repeat(SPEECH_TOOL_TEXT_MAX_LENGTH + 1) }),
    new Error(SPEECH_TOOL_TEXT_TOO_LONG_MESSAGE),
  );
  for (const path of ["../narration.mp3", "/narration.mp3", "generated\\narration.mp3", "generated/"]) {
    await assert.rejects(() => run(execute, { text: "hello", path }));
  }
  await assert.rejects(() => run(execute, { text: "hello", voice: "Ghost" }), new Error(SPEECH_TOOL_VOICE_MESSAGE));
  // 上限ちょうどは通す
  await run(execute, { text: "x".repeat(SPEECH_TOOL_TEXT_MAX_LENGTH) });
  assert.equal(capture.generated.length, 1, "拒否した呼び出しで provider を呼んでいる");
});

test("execute は毎回現在の設定を読み、未設定・キー削除後はキー無効エラーにする", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  let calls = 0;
  const execute = tool({
    capture,
    settings: () => {
      calls += 1;
      return calls === 1 ? settings : undefined;
    },
  });
  await run(execute, { text: "hello" });
  await assert.rejects(() => run(execute, { text: "hello" }), new Error(SPEECH_TOOL_KEY_UNSET_MESSAGE));
  assert.equal(capture.generated.length, 1, "未設定のときは provider を呼ばない");
});

test("設定の読取失敗と provider の失敗はマスクを通して throw する", async () => {
  const key = "sk-speech-dummy-key-0123456789abcdef";
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const masker = createMutableSecretMasker([key]);
  const readFailure = tool({
    capture,
    masker,
    settings: () => {
      throw new Error(`db boom ${key}`);
    },
  });
  await assert.rejects(
    () => run(readFailure, { text: "hello" }),
    (error: unknown) => !String((error as Error).message).includes(key),
    "設定の読取失敗の文言にキーが残っている",
  );

  const generationFailure = tool({
    capture,
    masker,
    settings,
    generate: async () => ({ ok: false, code: "unknown", message: `音声生成に失敗しました: ${key}` }),
  });
  await assert.rejects(
    () => run(generationFailure, { text: "hello" }),
    (error: unknown) =>
      !String((error as Error).message).includes(key) && String((error as Error).message).includes("[REDACTED]"),
    "provider の失敗の文言にキーが残っている",
  );
  assert.equal(capture.uploads.length, 0, "失敗した生成を保存している");
});

test("ユーザー中断の signal を provider へ渡す", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const controller = new AbortController();
  await run(tool({ capture, settings }), { text: "hello" }, controller.signal);
  assert.equal(capture.generated[0]?.signal, controller.signal);
});
