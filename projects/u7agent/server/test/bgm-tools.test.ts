import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendSystemPrompt, investigationSystemPrompt, sessionToolPlan } from "../src/agent";
import {
  BGM_MODEL,
  BGM_TIMEOUT_MS,
  createBgmGenerator,
  type BgmGenerationInput,
  type BgmGenerationSettings,
} from "../src/bgm";
import { bgmTarget, createBgmToolDefinitions, BGM_TOOL_NAME, type BgmToolDefinitionOptions } from "../src/bgm-tools";
import { createMutableSecretMasker } from "../src/redact";
import { createSandboxService } from "../src/sandbox/service";
import { createSandboxToolClient, type SandboxUploadInput, type SandboxWorkspaceClient } from "../src/sandbox/client";
import { REMOTE_TOOL_NAMES } from "../src/sandbox/remote-tools";
import { toolResultSummary } from "../src/session-projection";
import { SYNTHETIC_BGM_SSE, SYNTHETIC_MP3 } from "./fixtures/bgm-sse";

const settings: BgmGenerationSettings = { model: BGM_MODEL, apiKey: "sk-dummy-bgm-tool-key" };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(overrides: Partial<BgmToolDefinitionOptions> = {}) {
  const generated: BgmGenerationInput[] = [];
  const uploaded: SandboxUploadInput[] = [];
  const definitions = createBgmToolDefinitions({
    enabled: true,
    sessionCwd: "",
    masker: createMutableSecretMasker([settings.apiKey]),
    readSettings: () => settings,
    generate: async (input) => {
      generated.push(input);
      return new Uint8Array(SYNTHETIC_MP3);
    },
    workspace: {
      uploadFile: async (input) => {
        uploaded.push(input);
        return { path: `${input.dir}/${input.name}`, name: input.name, renamed: false, size: SYNTHETIC_MP3.length };
      },
    } as SandboxWorkspaceClient,
    ...overrides,
  });
  const run = async (params: Record<string, unknown> = { prompt: "Racing game" }, signal?: AbortSignal) => {
    const result = await definitions[0].execute("bgm-call", params, signal, undefined, {} as never);
    return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  };
  return { generated, uploaded, definitions, run };
}

test("公開はcontentゲートとtoolNamesの積で固定し、調査子とremoteには追加しない", () => {
  const availability = {
    sandboxTools: ["read"],
    contentGeneration: true,
    webSearch: false,
    serve: false,
    askUser: false,
    investigate: false,
  };
  for (const configured of [false, true]) {
    for (const allowed of [false, true]) {
      const plan = sessionToolPlan({
        base: [],
        availability: { ...availability, contentGeneration: configured },
        toolNames: allowed ? [BGM_TOOL_NAME] : [],
        investigation: false,
      });
      assert.deepEqual(plan.names, configured && allowed ? [BGM_TOOL_NAME] : []);
      assert.deepEqual([...plan.enabled], plan.names);
      const { definitions } = fixture({ enabled: plan.enabled.has(BGM_TOOL_NAME) });
      assert.deepEqual(
        definitions.map((tool) => tool.name),
        plan.names,
      );
    }
  }
  assert.equal(sessionToolPlan({ base: [], availability, investigation: true }).names.includes(BGM_TOOL_NAME), false);
  assert.equal((REMOTE_TOOL_NAMES as readonly string[]).includes(BGM_TOOL_NAME), false);
  assert.doesNotMatch(investigationSystemPrompt(), /generate_bgm/);
  assert.doesNotMatch(appendSystemPrompt("/workspace"), /generate_bgm/);
  const prompt = appendSystemPrompt("/workspace", { bgmGeneration: true });
  assert.match(prompt, /NEW instrumental/);
  assert.match(prompt, /verbatim TTS/);
  assert.match(prompt, /never regenerate without the user's explicit new request/);
  assert.deepEqual(Object.keys(Reflect.get(fixture().definitions[0].parameters, "properties")), ["prompt", "path"]);
});

test("空白・UTF-16のprompt上限・不正path・追加引数は送信前に失敗する", async () => {
  const f = fixture();
  for (const prompt of ["", " \n\t", "x".repeat(1001), "🎶".repeat(501)])
    await assert.rejects(f.run({ prompt }), /API未送信/);
  for (const path of [
    "",
    "/bgm.mp3",
    "C:/bgm.mp3",
    "..",
    "a/../bgm",
    "a\\bgm",
    "a/",
    ".hidden.mp3",
    "a/.hidden",
    "a.wav",
    "a.mp3.zip",
    "a.",
    "a b.mp3",
    "a\n.mp3",
    "a\u0000.mp3",
    "a\u0085.mp3",
    "a".repeat(797),
    "a".repeat(797) + ".mp3",
  ]) {
    await assert.rejects(f.run({ prompt: "BGM", path }), /API未送信/, path);
  }
  await assert.rejects(f.run({ prompt: "BGM", voice: "guessed" }), /API未送信/);
  assert.equal(f.generated.length, 0);
  assert.equal(f.uploaded.length, 0);
  await f.run({ prompt: "🎶".repeat(500) });
  assert.equal(f.generated.length, 1);
  assert.equal(bgmTarget("a".repeat(796)).name.length, 800);
  assert.deepEqual(bgmTarget("output/music"), { dir: "output", name: "music.mp3" });
});

test("既定と明示先はcwd相対で保存し、モデルと実保存先を先頭2行へ返す", async () => {
  const f = fixture({ sessionCwd: "projects/game" });
  const text = await f.run();
  assert.equal(f.uploaded[0].dir, "projects/game/generated");
  assert.equal(f.uploaded[0].name, "bgm-racing-game.mp3");
  assert.equal(text.split("\n")[0], `モデル: ${BGM_MODEL}`);
  assert.equal(text.split("\n")[1], "BGMを生成して保存しました: generated/bgm-racing-game.mp3");
  assert.equal(f.uploaded[0].signal, f.generated[0].signal);
  assert.deepEqual(Buffer.from(await new Response(f.uploaded[0].body).arrayBuffer()), SYNTHETIC_MP3);
  await f.run({ prompt: "日本語", path: "output/bgm" });
  assert.equal(f.uploaded[1].dir, "projects/game/output");
  assert.equal(f.uploaded[1].name, "bgm.mp3");
  const path = Array(4).fill("a".repeat(190)).join("/") + "/" + "b".repeat(32) + ".mp3";
  assert.equal(path.length, 800);
  const long = fixture({
    workspace: {
      uploadFile: async (input) => ({
        name: input.name.replace(".mp3", "-123.mp3"),
        path: "ignored",
        size: 1,
        renamed: true,
      }),
    } as SandboxWorkspaceClient,
  });
  const projected = toolResultSummary(
    { content: [{ type: "text", text: await long.run({ prompt: "BGM", path }) }] },
    createMutableSecretMasker([]),
  );
  assert.match(projected, new RegExp(`^モデル: ${BGM_MODEL}\\nBGMを生成して保存しました: .+-123\\.mp3\\n`));
});

test("実行は現在キーを読み、回転・削除へ追随し、mask済み500文字までのエラーを返す", async () => {
  let current: BgmGenerationSettings | undefined = settings;
  const masker = createMutableSecretMasker([settings.apiKey, "sk-rotated-dummy-key"]);
  const f = fixture({ readSettings: () => current, masker });
  await f.run();
  current = { ...settings, apiKey: "sk-rotated-dummy-key" };
  await f.run();
  current = undefined;
  await assert.rejects(f.run(), /API未送信/);
  assert.deepEqual(
    f.generated.map((call) => call.apiKey),
    [settings.apiKey, "sk-rotated-dummy-key"],
  );
  for (const failure of ["read", "generate", "upload"] as const) {
    const fail = () => {
      throw new Error(`${settings.apiKey}${"x".repeat(2000)}`);
    };
    const f = fixture({
      masker,
      ...(failure === "read"
        ? { readSettings: fail }
        : failure === "generate"
          ? { generate: fail }
          : { workspace: { uploadFile: fail } as unknown as SandboxWorkspaceClient }),
    });
    await assert.rejects(
      f.run(),
      (error: Error) => !error.message.includes(settings.apiKey) && error.message.includes("[REDACTED]"),
    );
    assert.equal(failure === "read" ? f.generated.length : 0, 0);
  }
});

test("不完全な受信やprovider異常はuploadせずツールエラーで終える", async () => {
  for (const text of [SYNTHETIC_BGM_SSE.slice(0, -10), 'data: {"error":{"message":"bad"}}\n\n', "data: {bad}\n\n"]) {
    const generate = createBgmGenerator({
      fetchImpl: async () => new Response(text, { headers: { "content-type": "text/event-stream" } }),
    }).generate;
    const f = fixture({ generate });
    await assert.rejects(f.run(), /課金されている可能性/);
    assert.equal(f.uploaded.length, 0);
  }
});

test("同時2枠は生成から保存完了までプロセス共有、超過送信なし・中断後に回収", async () => {
  const controllers = [new AbortController(), new AbortController()];
  const pendingUpload = { uploadFile: () => new Promise(() => {}) } as unknown as SandboxWorkspaceClient;
  const f = fixture({ workspace: pendingUpload });
  const tasks = controllers.map((controller) =>
    assert.rejects(f.run(undefined, controller.signal), /中断.*課金されている可能性/),
  );
  await turn();
  assert.equal(f.generated.length, 2);
  const otherSession = fixture();
  await assert.rejects(otherSession.run(), /同時に2件.*API未送信/);
  assert.equal(otherSession.generated.length, 0);
  controllers.forEach((controller) => controller.abort());
  await Promise.all(tasks);
  await otherSession.run();
  assert.equal(otherSession.uploaded.length, 1);
});

test("180秒絶対期限はヘッダ・SSE keep-alive・upload応答本文まで通算する", async (t) => {
  assert.equal(BGM_TIMEOUT_MS, 180000);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveHeaders!: (response: Response) => void;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = 0;
  const generate = createBgmGenerator({
    fetchImpl: () =>
      new Promise((yes) => {
        resolveHeaders = yes;
      }),
  }).generate;
  const f = fixture({
    generate,
    workspace: { uploadFile: () => new Promise(() => {}) } as unknown as SandboxWorkspaceClient,
  });
  const expired = assert.rejects(f.run(), /保存に失敗.*タイムアウト.*課金されている可能性/);
  t.mock.timers.tick(60000);
  resolveHeaders(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
        cancel() {
          canceled += 1;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  await turn();
  stream.enqueue(Buffer.from(": keep-alive\n\n"));
  t.mock.timers.tick(60000);
  stream.enqueue(Buffer.from(SYNTHETIC_BGM_SSE));
  await turn();
  t.mock.timers.tick(59999);
  let settled = false;
  void expired.then(() => {
    settled = true;
  });
  await turn();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await expired;
  assert.equal(canceled, 1);
  await fixture().run();
});

test("期限はヘッダ未着・SSE未完了でも止まり、ユーザー停止も同じ接続へ伝播する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const stage of ["headers", "stream"] as const) {
    for (const cause of ["timeout", "user"] as const) {
      let signal: AbortSignal | null | undefined;
      const generate = createBgmGenerator({
        fetchImpl: async (_url, init) => {
          signal = init?.signal;
          if (stage === "headers") return new Promise(() => {});
          return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
        },
      }).generate;
      const f = fixture({ generate });
      const caller = new AbortController();
      const expired = assert.rejects(f.run(undefined, caller.signal), cause === "timeout" ? /タイムアウト/ : /中断/);
      await turn();
      if (cause === "timeout") t.mock.timers.tick(BGM_TIMEOUT_MS);
      else caller.abort();
      await expired;
      assert.equal(signal?.aborted, true);
      assert.equal(getEventListeners(caller.signal, "abort").length, 0);
      assert.equal(f.uploaded.length, 0);
      await fixture().run();
    }
  }
  const before = new AbortController();
  before.abort();
  const f = fixture();
  await assert.rejects(f.run(undefined, before.signal), /API未送信/);
  assert.equal(f.generated.length, 0);
});

test("既存uploadの非上書き・symlink境界を保ち、cwdとraw/Rangeの参照先が一致する", async () => {
  const root = await mkdtemp(join(tmpdir(), "u7agent-bgm-"));
  const outside = await mkdtemp(join(tmpdir(), "u7agent-bgm-outside-"));
  const sandbox = createSandboxService({ token: "bgm-test-token-not-real", rootCwd: root });
  const workspace = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: "bgm-test-token-not-real",
    fetchImpl: async (url, init) => sandbox.app.request(String(url), init),
  });
  try {
    for (const sessionCwd of ["project/game", ".u7agent/sessions/session-test", ""]) {
      const f = fixture({ sessionCwd, workspace });
      await f.run({ prompt: "BGM", path: "output/track" });
      const dest = join(root, sessionCwd, "output/track.mp3");
      await writeFile(dest, "keep original");
      const text = await f.run({ prompt: "BGM", path: "output/track" });
      assert.match(text, /BGMを生成して保存しました: output\/track-1.mp3\n/);
      assert.equal(await readFile(dest, "utf8"), "keep original");
      assert.deepEqual(await readFile(join(root, sessionCwd, "output/track-1.mp3")), SYNTHETIC_MP3);
      const raw = await workspace.rawFile([sessionCwd, "output/track-1.mp3"].filter(Boolean).join("/"), {
        range: "bytes=0-3",
      });
      assert.equal(raw.status, 206);
      assert.equal(raw.contentType, "audio/mpeg");
      assert.deepEqual(Buffer.from(await new Response(raw.body).arrayBuffer()), SYNTHETIC_MP3.subarray(0, 4));
    }
    await symlink(outside, join(root, "escape"));
    const f = fixture({ workspace });
    await assert.rejects(
      f.run({ prompt: "BGM", path: "escape/music.mp3" }),
      /生成後の保存に失敗.*課金されている可能性/,
    );
    assert.deepEqual(await readdir(outside), []);
    await mkdir(join(root, "inside"));
    await symlink(join(root, "inside"), join(root, "alias"));
    await fixture({ sessionCwd: "alias", workspace }).run({ prompt: "BGM", path: "ok.mp3" });
    assert.deepEqual(await readFile(join(root, "inside/ok.mp3")), SYNTHETIC_MP3);
  } finally {
    sandbox.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
