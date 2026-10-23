// generate_image ツールの組み立てと保存規則。実 API もサンドボックスも使わず、fake workspace / stub generator で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createImageToolDefinitions,
  imageExtensionFor,
  imageSlug,
  IMAGE_GENERATION_PROMPT_LINES,
  IMAGE_TOOL_GUIDELINES,
  IMAGE_TOOL_NAME,
  sessionToolNames,
} from "../src/image-tools";
import { createMutableSecretMasker } from "../src/redact";
import { toolResultSummary } from "../src/session-projection";
import type { SandboxUploadInput, SandboxWorkspaceClient } from "../src/sandbox/client";
import { cwdRelativePath, parseToolPath, rootRelativeDir } from "../src/workspace-path";

type AnyTool = ToolDefinition<any, any, any>;

interface Capture {
  uploads: SandboxUploadInput[];
  /** アップロード本文を読んだ結果 */
  bodies: Buffer[];
  generated: { provider: string; model: string; prompt: string; apiKey: string; signal?: AbortSignal | undefined }[];
  /** 画像入力を参照消費した回だけ増える（provider へ渡した data URL） */
  inputPayloads: (readonly string[] | undefined)[];
  /** 参照画像の読取要求（path / scope） */
  reads: { path: string; scope: readonly string[] }[];
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

function tool(options: {
  enabled?: boolean;
  sessionCwd?: string;
  rootCwd?: string;
  uploadsDirRel?: string;
  capture: Capture;
  masker?: ReturnType<typeof createMutableSecretMasker>;
  settings?:
    | { provider: string; model: string; apiKey: string }
    | undefined
    | (() => { provider: string; model: string; apiKey: string } | undefined);
  outputFormats?: (model: string) => readonly string[] | undefined;
  /** root 相対のパス → 返す画像バイト。無いパスは「読めない」として失敗させる */
  inputFiles?: Record<string, Uint8Array>;
  checkImageInput?: (model: string) => Promise<string | undefined>;
  readImageInput?: (path: string, scope: readonly string[]) => Promise<Uint8Array>;
  generate?: (input: {
    provider: string;
    model: string;
    prompt: string;
    apiKey: string;
    signal?: AbortSignal | undefined;
    inputReferences?: readonly string[] | undefined;
  }) => Promise<unknown>;
  workspaceResult?: (input: SandboxUploadInput) => { path: string; name: string; renamed: boolean; size: number };
}): AnyTool {
  const settingsOption = options.settings;
  const definitions = createImageToolDefinitions({
    enabled: options.enabled ?? true,
    sessionCwd: options.sessionCwd ?? "",
    rootCwd: options.rootCwd ?? "/workspace",
    uploadsDirRel: options.uploadsDirRel ?? ".u7agent/uploads/0123456789",
    workspace: fakeWorkspace(options.capture, options.workspaceResult),
    masker: options.masker ?? createMutableSecretMasker([]),
    readSettings: () => (typeof settingsOption === "function" ? settingsOption() : settingsOption),
    readOutputFormats: options.outputFormats ?? (() => undefined),
    checkImageInput: options.checkImageInput ?? (async () => undefined),
    readImageInput: async (path, scope) => {
      options.capture.reads.push({ path, scope });
      if (options.readImageInput) return options.readImageInput(path, scope);
      const bytes = options.inputFiles?.[path];
      if (!bytes) throw new Error(`参照画像が見つかりません: ${path}`);
      return bytes;
    },
    generate: async (input) => {
      const { inputReferences, ...rest } = input;
      options.capture.generated.push(rest);
      options.capture.inputPayloads.push(inputReferences);
      if (options.generate) return (await options.generate(input)) as never;
      return { ok: true, image: { mimeType: "image/png", data: Buffer.from("hello").toString("base64") } };
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

const settings = { provider: "openrouter", model: "openai/gpt-image-2", apiKey: "sk-image-dummy-key" };

test("path の拒否規則: `..` / 絶対パス / バックスラッシュ / 空の name", () => {
  assert.deepEqual(parseToolPath("generated/cafe.png"), { dir: "generated", name: "cafe.png" });
  assert.deepEqual(parseToolPath("cafe.png"), { dir: "", name: "cafe.png" });
  assert.deepEqual(parseToolPath("./a//b.png"), { dir: "a", name: "b.png" });
  for (const bad of [
    "",
    "  ",
    "../cafe.png",
    "generated/../../cafe.png",
    "/cafe.png",
    "/etc/cafe.png",
    "C:/cafe.png",
    "generated\\cafe.png",
    "generated/",
    "generated/..",
  ]) {
    assert.throws(() => parseToolPath(bad), Error, bad);
  }
});

test("slug は [a-z0-9-] へ正規化して 40 文字まで、取れなければ日時", () => {
  assert.equal(imageSlug("A Cafe in Kyoto!", 0), "a-cafe-in-kyoto");
  assert.equal(imageSlug("x".repeat(60), 0), "x".repeat(40));
  assert.equal(imageSlug(`${"a".repeat(39)} b`, 0), "a".repeat(39));
  assert.equal(
    imageSlug("日本語のプロンプト", Date.parse("2026-09-28T12:34:56.000Z")),
    "image-2026-09-28T12-34-56-000Z",
  );
});

test("拡張子は mimeType から決め、png / jpeg / webp 以外は失敗にする", () => {
  assert.equal(imageExtensionFor("image/png"), "png");
  assert.equal(imageExtensionFor("image/jpeg"), "jpeg");
  assert.equal(imageExtensionFor("image/jpg"), "jpeg");
  assert.equal(imageExtensionFor("image/webp"), "webp");
  assert.equal(imageExtensionFor("image/png; charset=binary"), "png");
  assert.throws(() => imageExtensionFor("image/svg+xml"));
});

test("root 相対への前置きと cwd 相対の結果パス", () => {
  assert.equal(rootRelativeDir("", "generated"), "generated");
  assert.equal(rootRelativeDir("projects/u7agent", ""), "projects/u7agent");
  assert.equal(rootRelativeDir("projects/u7agent", "generated"), "projects/u7agent/generated");
  assert.equal(cwdRelativePath("", "cafe.png"), "cafe.png");
  assert.equal(cwdRelativePath("generated", "cafe-1.png"), "generated/cafe-1.png");
});

test("ツール一覧は有効なときだけ generate_image を足す", () => {
  assert.deepEqual(sessionToolNames(["read", "bash"], { image: false, speech: false }), ["read", "bash"]);
  assert.deepEqual(sessionToolNames(["read"], { image: true, speech: false }), ["read", IMAGE_TOOL_NAME]);
  assert.deepEqual(
    createImageToolDefinitions({
      enabled: false,
      sessionCwd: "",
      rootCwd: "/workspace",
      uploadsDirRel: ".u7agent/uploads/0123456789",
      workspace: {} as SandboxWorkspaceClient,
      masker: createMutableSecretMasker([]),
      readSettings: () => undefined,
      readOutputFormats: () => undefined,
      checkImageInput: async () => undefined,
      readImageInput: async () => new Uint8Array(),
      generate: async () => ({ ok: false, code: "unknown", message: "x" }),
    }),
    [],
  );
});

test("path の説明と system prompt は結果パスの参照と一意な生成ファイルの保持を指示する", () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  const definition = tool({ capture, settings });
  assert.deepEqual(
    Object.keys(definition.parameters.properties),
    ["prompt", "path", "input_images"],
    "引数は既知の 3 つだけ",
  );
  const pathDescription = definition.parameters.properties.path.description;
  assert.equal(typeof pathDescription, "string");
  for (const instructions of [pathDescription, IMAGE_GENERATION_PROMPT_LINES.join("\n")]) {
    assert.match(instructions, /not overwritten|Do not overwrite/);
    assert.match(instructions, /actual saved path returned by the tool/);
    assert.match(instructions, /unique.*file.*unchanged/);
    assert.match(instructions, /`cp` to a separate path/);
    assert.match(instructions, /never.*`mv`.*file referenced by the conversation/i);
  }
  // 参照画像は説明だけでなく model 向けのガイドラインにも、外部送信と元画像を消さないことを書く
  const inputDescription = definition.parameters.properties.input_images?.items?.description;
  assert.equal(typeof inputDescription, "string");
  assert.match(inputDescription as string, /PNG \/ JPEG \/ WebP/);
  assert.match(inputDescription as string, /source is unchanged/);
  assert.match(IMAGE_TOOL_GUIDELINES.join("\n"), /sent to the external provider unchanged/);
  assert.match(IMAGE_GENERATION_PROMPT_LINES.join("\n"), /sent to the external image provider unchanged/);
});

test("省略時は generated/<slug>.<ext> へ保存し、実際の cwd 相対パスを結果に載せる", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  const text = await run(tool({ capture, settings, sessionCwd: "projects/u7agent" }), { prompt: "A Cafe in Kyoto!" });
  assert.equal(capture.uploads.length, 1);
  assert.equal(capture.uploads[0].dir, "projects/u7agent/generated");
  assert.match(capture.uploads[0].name, /^a-cafe-in-kyoto[a-z0-9-]*\.png$/);
  assert.deepEqual(capture.bodies[0], Buffer.from("hello"));
  assert.ok(text.includes("generated/"), text);
  assert.ok(!text.includes("projects/u7agent/generated/"), "root 相対を返している");
  assert.ok(text.includes("モデル: openai/gpt-image-2"), "使用モデルを結果に残す");
  assert.ok(text.includes("Markdown 画像"), text);
});

test("path を明示したときは拡張子も含めてそのまま使う", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  const text = await run(tool({ capture, settings, sessionCwd: "projects/u7agent" }), {
    prompt: "hero",
    path: "assets/hero.jpg",
  });
  assert.equal(capture.uploads[0].dir, "projects/u7agent/assets");
  assert.equal(capture.uploads[0].name, "hero.jpg");
  assert.ok(text.includes("assets/hero.jpg"));
});

test("同名衝突ではサンドボックスが返した実際の名前を結果に載せる", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  const text = await run(
    tool({
      capture,
      settings,
      workspaceResult: (input) => ({
        path: input.dir ? `${input.dir}/${input.name}` : input.name,
        name: "a-cafe-1.png",
        renamed: true,
        size: 0,
      }),
    }),
    { prompt: "a cafe" },
  );
  assert.ok(text.includes("generated/a-cafe-1.png"), text);
  assert.ok(text.includes("![alt](generated/a-cafe-1.png)"), "本文にも実際の保存パスを使わせる");
  assert.ok(!text.includes("![alt](generated/a-cafe.png)"), "要求した元のパスを本文に使わせない");
});

test("長い path でも使用モデルは投影の切詰め内に残る", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  // 投影 (SUMMARY_TEXT_MAX = 900) より長い path。basename は有効なまま
  const longDir = Array.from({ length: 5 }, () => "d".repeat(180)).join("/");
  const text = await run(tool({ capture, settings }), { prompt: "cafe", path: `${longDir}/cafe.png` });
  // ライブ / 復元後のツール履歴と同じ投影を通してもモデル行が見える
  const projected = toolResultSummary({ content: [{ type: "text", text }] }, createMutableSecretMasker([]));
  assert.ok(projected.includes("モデル: openai/gpt-image-2"), projected.slice(0, 120));
});

test("path が不正なら provider を呼ばずに拒否する", async () => {
  for (const path of ["../cafe.png", "/cafe.png", "generated\\cafe.png", "generated/"]) {
    const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
    await assert.rejects(() => run(tool({ capture, settings }), { prompt: "cafe", path }));
    assert.equal(capture.generated.length, 0, "拒否した path で生成を呼んでいる");
  }
});

test("execute は毎回現在の設定を読み、未設定・キー削除後はキー無効エラーにする", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  let calls = 0;
  const execute = tool({
    capture,
    settings: () => {
      calls += 1;
      return calls === 1 ? settings : undefined;
    },
  });
  await run(execute, { prompt: "cafe" });
  await assert.rejects(() => run(execute, { prompt: "cafe" }), /画像APIキーが未設定です/);
  assert.equal(capture.generated.length, 1, "未設定のときは provider を呼ばない");
});

test("設定の読取失敗と provider の失敗はマスクを通して throw する", async () => {
  const key = "sk-image-dummy-key-0123456789abcdef";
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  const masker = createMutableSecretMasker([key]);
  const readFailure = tool({
    capture,
    settings: () => {
      throw new Error(`db exploded ${key}`);
    },
    masker,
  });
  await assert.rejects(async () => {
    try {
      await run(readFailure, { prompt: "cafe" });
    } catch (error) {
      assert.ok(!(error as Error).message.includes(key));
      throw error;
    }
  }, /画像生成の設定を読み取れませんでした/);

  const generateFailure = tool({
    capture,
    settings,
    masker,
    generate: async () => ({ ok: false, code: "unknown", message: `provider boom ${key}` }),
  });
  await assert.rejects(async () => {
    try {
      await run(generateFailure, { prompt: "cafe" });
    } catch (error) {
      assert.ok(!(error as Error).message.includes(key), "ローカル定義の throw もマスクする");
      assert.ok((error as Error).message.includes("[REDACTED]"));
      throw error;
    }
  }, /provider boom/);

  // 引数を反射する path の拒否文言も、包んだマスカーを通る
  const pathFailure = tool({ capture, settings, masker });
  await assert.rejects(async () => {
    try {
      await run(pathFailure, { prompt: "cafe", path: `../${key}` });
    } catch (error) {
      assert.ok(!(error as Error).message.includes(key), "path の拒否文言もマスクする");
      assert.ok((error as Error).message.includes("[REDACTED]"));
      throw error;
    }
  }, /作業フォルダの外には保存できません/);
  assert.equal(capture.generated.length, 1, "拒否した path で生成を呼んでいない");
});

test("mimeType が未知なら保存せず、生成済みで課金されていることまで文言に載せる", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  const execute = tool({
    capture,
    settings,
    generate: async () => ({ ok: true, image: { mimeType: "image/svg+xml", data: "PHN2Zz4=" } }),
  });
  const error = await run(execute, { prompt: "cafe" }).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /対応していない画像形式/);
  assert.match(error.message, /生成は完了しており、クレジットは消費されています/);
  assert.match(error.message, /別の画像モデル/);
  assert.equal(capture.uploads.length, 0);
});

test("保存できる形式を宣言していないモデルは provider を叩く前に止める", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  const execute = tool({ capture, settings, outputFormats: () => ["svg"] });
  const error = await run(execute, { prompt: "cafe" }).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /生成は行っていません/);
  assert.match(error.message, /クレジットは消費していません/);
  assert.match(error.message, /別の画像モデル/);
  assert.equal(capture.generated.length, 0, "生成 API を叩く前に止める");
});

test("形式が不明 / 保存できる形式を含む宣言のモデルは止めない", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  for (const formats of [undefined, [], ["svg", "png"], ["webp"]]) {
    await run(tool({ capture, settings, outputFormats: () => formats }), { prompt: "cafe" });
  }
  assert.equal(capture.generated.length, 4, "宣言が不明なときは従来どおり送る");
});

test("中断は provider 呼び出しへ signal を渡す", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  const controller = new AbortController();
  await run(tool({ capture, settings }), { prompt: "cafe" }, controller.signal);
  assert.equal(capture.generated[0].signal, controller.signal);
});

test("カタログにしか無いモデルの保存値もそのまま provider へ渡す", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  // 生成側はカタログを知らない (SDK の一覧に無い id をローカルで弾かない)
  const liveOnly = { ...settings, model: "recraft/recraft-v4.1-flash" };
  const text = await run(tool({ capture, settings: liveOnly }), { prompt: "cafe" });
  assert.equal(capture.generated[0].model, "recraft/recraft-v4.1-flash");
  assert.ok(text.includes("モデル: recraft/recraft-v4.1-flash"), text);
});

// --- 参照画像（input_images）。実形式は実バイトで決め、課金前に検証を終える ---

/** IHDR だけを持つ PNG。形式判定はヘッダで行うため、幅・高さの検査に必要な最小構成にする */
function pngBytes(width = 2, height = 2): Uint8Array {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return new Uint8Array(bytes);
}

test("input_images を省略すると従来どおり参照なしで生成し、編集元の行も足さない", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  const text = await run(tool({ capture, settings }), { prompt: "cafe" });
  assert.equal(capture.reads.length, 0, "参照なしで画像を読みに行っている");
  assert.deepEqual(capture.inputPayloads, [undefined], "input_references を組み立てている");
  assert.ok(!text.includes("編集元"), text);
});

test("生成済み画像を参照すると data URL を provider へ渡し、新規ファイルとして保存する", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  const bytes = pngBytes(3, 4);
  const execute = tool({
    capture,
    settings,
    sessionCwd: "projects/app",
    inputFiles: { "projects/app/generated/portrait.png": bytes },
  });
  const text = await run(execute, { prompt: "背景を白に", input_images: ["generated/portrait.png"] });

  // 許可範囲は BFF が決めた cwd と添付置き場だけで、root 相対へ直してからサンドボックスへ渡す
  assert.deepEqual(capture.reads, [
    { path: "projects/app/generated/portrait.png", scope: ["projects/app", ".u7agent/uploads/0123456789"] },
  ]);
  const payloads = capture.inputPayloads[0];
  assert.ok(payloads);
  assert.equal(payloads.length, 1);
  const [header, encoded] = String(payloads[0]).split(",");
  assert.equal(header, "data:image/png;base64");
  assert.deepEqual(new Uint8Array(Buffer.from(encoded as string, "base64")), bytes);

  // 元画像は上書きせず、結果は別ファイル。結果本文の先頭 2 行は従来の形のまま
  assert.equal(capture.uploads.length, 1);
  assert.equal(capture.uploads[0].dir, "projects/app/generated");
  assert.match(capture.uploads[0].name, /^image-/);
  assert.match(text, /^モデル: openai\/gpt-image-2\n画像を生成して保存しました: /);
  assert.ok(text.includes(`画像を生成して保存しました: generated/${capture.uploads[0].name}`), text);
  assert.ok(text.includes("編集元: generated/portrait.png"), text);
  assert.ok(!text.includes(encoded as string), "base64 を結果へ載せない");
});

test("添付の絶対パスは追加スペースの添付置き場から読む", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  const uploadsDirRel = ".u7agent/spaces/blue/uploads/0123456789";
  const execute = tool({
    capture,
    settings,
    sessionCwd: "projects/app",
    uploadsDirRel,
    inputFiles: { [`${uploadsDirRel}/photo.png`]: pngBytes() },
  });
  const text = await run(execute, {
    prompt: "人物はそのまま",
    input_images: [`/workspace/${uploadsDirRel}/photo.png`],
  });
  assert.deepEqual(capture.reads, [{ path: `${uploadsDirRel}/photo.png`, scope: ["projects/app", uploadsDirRel] }]);
  assert.ok(text.includes(`編集元: ${uploadsDirRel}/photo.png`), text);
});

test("無拡張子・実体と違う拡張子の入力も実バイトの形式で通す", async () => {
  for (const name of ["notes.bin", "photo.jpg", "portrait"]) {
    const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
    const execute = tool({
      capture,
      settings,
      sessionCwd: "projects/app",
      inputFiles: { [`projects/app/${name}`]: pngBytes() },
    });
    await run(execute, { prompt: "背景を白に", input_images: [name] });
    assert.match(String(capture.inputPayloads[0]?.[0]), /^data:image\/png;base64,/, name);
  }
});

test("能力が不明・非対応なら provider を呼ばず、参照を外した再試行もしない", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  const execute = tool({
    capture,
    settings,
    sessionCwd: "projects/app",
    inputFiles: { "projects/app/generated/portrait.png": pngBytes() },
    checkImageInput: async () => "この画像モデルは参照画像による編集に対応していません",
  });
  const error = await run(execute, { prompt: "背景を白に", input_images: ["generated/portrait.png"] }).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /参照画像による編集に対応していません/);
  assert.equal(capture.generated.length, 0, "provider を呼んでいる");
  assert.equal(capture.uploads.length, 0);

  // 参照なしの生成は能力判定を通らない（新規生成を巻き添えにしない）
  const noInput: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  await run(
    tool({
      capture: noInput,
      settings,
      checkImageInput: async () => {
        throw new Error("参照なしの生成で能力判定を呼んでいる");
      },
    }),
    { prompt: "cafe" },
  );
  assert.equal(noInput.generated.length, 1);
});

test("入力の不備はどれも provider を呼ぶ前に拒む", async () => {
  const cases: { params: Record<string, unknown>; pattern: RegExp; files?: Record<string, Uint8Array> }[] = [
    { params: { input_images: [] }, pattern: /input_images が空です/ },
    { params: { input_images: [""] }, pattern: /パスが空です/ },
    { params: { input_images: ["a.png", "b.png"] }, pattern: /1 枚だけです/ },
    { params: { input_images: ["../secret.png"] }, pattern: /作業フォルダの外/ },
    { params: { input_images: ["/etc/passwd"] }, pattern: /作業フォルダの外/ },
    { params: { input_images: ["generated\\portrait.png"] }, pattern: /バックスラッシュ/ },
    { params: { input_images: ["https://example.invalid/a.png"] }, pattern: /ローカル画像のパスだけ/ },
    { params: { input_images: ["data:image/png;base64,AAAA"] }, pattern: /ローカル画像のパスだけ/ },
    { params: { input_images: ["generated/missing.png"] }, pattern: /参照画像が見つかりません/ },
    {
      params: { input_images: ["generated/fake.png"] },
      pattern: /参照画像として使えるのは/,
      files: { "generated/fake.png": new Uint8Array(Buffer.from("<html><body>not an image</body></html>")) },
    },
    {
      params: { input_images: ["generated/huge.png"] },
      pattern: /大きすぎます/,
      files: { "generated/huge.png": new Uint8Array(10 * 1024 * 1024 + 1) },
    },
    {
      params: { input_images: ["generated/tall.png"] },
      pattern: /画素数が上限を超えています/,
      files: { "generated/tall.png": pngBytes(20_000, 20_000) },
    },
  ];
  for (const testCase of cases) {
    const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
    const execute = tool({ capture, settings, ...(testCase.files ? { inputFiles: testCase.files } : {}) });
    await assert.rejects(
      () => run(execute, { prompt: "背景を白に", ...testCase.params }),
      testCase.pattern,
      JSON.stringify(testCase.params),
    );
    assert.equal(capture.generated.length, 0, `provider を呼んでいる: ${JSON.stringify(testCase.params)}`);
    assert.equal(capture.uploads.length, 0);
  }
});

test("参照画像の読取中の中断は画像生成の中断として返す", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [], inputPayloads: [], reads: [] };
  const controller = new AbortController();
  const execute = tool({
    capture,
    settings,
    readImageInput: async () => {
      controller.abort();
      throw new Error("The operation was aborted");
    },
  });
  await assert.rejects(
    () => run(execute, { prompt: "背景を白に", input_images: ["generated/portrait.png"] }, controller.signal),
    /画像生成を中断しました/,
  );
  assert.equal(capture.generated.length, 0);
});
