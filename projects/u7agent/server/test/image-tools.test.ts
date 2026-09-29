// generate_image ツールの組み立てと保存規則。実 API もサンドボックスも使わず、fake workspace / stub generator で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createImageToolDefinitions,
  cwdRelativePath,
  imageExtensionFor,
  imageSlug,
  IMAGE_TOOL_NAME,
  parseImageToolPath,
  rootRelativeDir,
  sessionToolNames,
} from "../src/image-tools";
import { createMutableSecretMasker } from "../src/redact";
import { toolResultSummary } from "../src/session-projection";
import type { SandboxUploadInput, SandboxWorkspaceClient } from "../src/sandbox/client";

type AnyTool = ToolDefinition<any, any, any>;

interface Capture {
  uploads: SandboxUploadInput[];
  /** アップロード本文を読んだ結果 */
  bodies: Buffer[];
  generated: { provider: string; model: string; prompt: string; apiKey: string; signal?: AbortSignal | undefined }[];
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
  capture: Capture;
  masker?: ReturnType<typeof createMutableSecretMasker>;
  settings?:
    | { provider: string; model: string; apiKey: string }
    | undefined
    | (() => { provider: string; model: string; apiKey: string } | undefined);
  generate?: (input: Capture["generated"][number]) => Promise<unknown>;
  workspaceResult?: (input: SandboxUploadInput) => { path: string; name: string; renamed: boolean; size: number };
}): AnyTool {
  const settingsOption = options.settings;
  const definitions = createImageToolDefinitions({
    enabled: options.enabled ?? true,
    sessionCwd: options.sessionCwd ?? "",
    workspace: fakeWorkspace(options.capture, options.workspaceResult),
    masker: options.masker ?? createMutableSecretMasker([]),
    readSettings: () => (typeof settingsOption === "function" ? settingsOption() : settingsOption),
    generate: async (input) => {
      options.capture.generated.push(input);
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
  assert.deepEqual(parseImageToolPath("generated/cafe.png"), { dir: "generated", name: "cafe.png" });
  assert.deepEqual(parseImageToolPath("cafe.png"), { dir: "", name: "cafe.png" });
  assert.deepEqual(parseImageToolPath("./a//b.png"), { dir: "a", name: "b.png" });
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
    assert.throws(() => parseImageToolPath(bad), Error, bad);
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
  assert.deepEqual(sessionToolNames(["read", "bash"], false), ["read", "bash"]);
  assert.deepEqual(sessionToolNames(["read"], true), ["read", IMAGE_TOOL_NAME]);
  assert.deepEqual(
    createImageToolDefinitions({
      enabled: false,
      sessionCwd: "",
      workspace: {} as SandboxWorkspaceClient,
      masker: createMutableSecretMasker([]),
      readSettings: () => undefined,
      generate: async () => ({ ok: false, code: "unknown", message: "x" }),
    }),
    [],
  );
});

test("省略時は generated/<slug>.<ext> へ保存し、実際の cwd 相対パスを結果に載せる", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
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
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const text = await run(tool({ capture, settings, sessionCwd: "projects/u7agent" }), {
    prompt: "hero",
    path: "assets/hero.jpg",
  });
  assert.equal(capture.uploads[0].dir, "projects/u7agent/assets");
  assert.equal(capture.uploads[0].name, "hero.jpg");
  assert.ok(text.includes("assets/hero.jpg"));
});

test("同名衝突ではサンドボックスが返した実際の名前を結果に載せる", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
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
});

test("長い path でも使用モデルは投影の切詰め内に残る", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  // 投影 (SUMMARY_TEXT_MAX = 900) より長い path。basename は有効なまま
  const longDir = Array.from({ length: 5 }, () => "d".repeat(180)).join("/");
  const text = await run(tool({ capture, settings }), { prompt: "cafe", path: `${longDir}/cafe.png` });
  // ライブ / 復元後のツール履歴と同じ投影を通してもモデル行が見える
  const projected = toolResultSummary({ content: [{ type: "text", text }] }, createMutableSecretMasker([]));
  assert.ok(projected.includes("モデル: openai/gpt-image-2"), projected.slice(0, 120));
});

test("path が不正なら provider を呼ばずに拒否する", async () => {
  for (const path of ["../cafe.png", "/cafe.png", "generated\\cafe.png", "generated/"]) {
    const capture: Capture = { uploads: [], bodies: [], generated: [] };
    await assert.rejects(() => run(tool({ capture, settings }), { prompt: "cafe", path }));
    assert.equal(capture.generated.length, 0, "拒否した path で生成を呼んでいる");
  }
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
  await run(execute, { prompt: "cafe" });
  await assert.rejects(() => run(execute, { prompt: "cafe" }), /画像APIキーが未設定です/);
  assert.equal(capture.generated.length, 1, "未設定のときは provider を呼ばない");
});

test("設定の読取失敗と provider の失敗はマスクを通して throw する", async () => {
  const key = "sk-image-dummy-key-0123456789abcdef";
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
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

test("mimeType が未知なら保存せずに失敗する", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const execute = tool({
    capture,
    settings,
    generate: async () => ({ ok: true, image: { mimeType: "image/svg+xml", data: "PHN2Zz4=" } }),
  });
  await assert.rejects(() => run(execute, { prompt: "cafe" }), /対応していない画像形式/);
  assert.equal(capture.uploads.length, 0);
});

test("中断は provider 呼び出しへ signal を渡す", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  const controller = new AbortController();
  await run(tool({ capture, settings }), { prompt: "cafe" }, controller.signal);
  assert.equal(capture.generated[0].signal, controller.signal);
});

test("カタログにしか無いモデルの保存値もそのまま provider へ渡す", async () => {
  const capture: Capture = { uploads: [], bodies: [], generated: [] };
  // 生成側はカタログを知らない (SDK の一覧に無い id をローカルで弾かない)
  const liveOnly = { ...settings, model: "recraft/recraft-v4.1-flash" };
  const text = await run(tool({ capture, settings: liveOnly }), { prompt: "cafe" });
  assert.equal(capture.generated[0].model, "recraft/recraft-v4.1-flash");
  assert.ok(text.includes("モデル: recraft/recraft-v4.1-flash"), text);
});
