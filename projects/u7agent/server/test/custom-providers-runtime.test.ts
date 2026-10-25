// カスタムプロバイダーの実 SDK 結合。fake の OpenAI 互換サーバーへ登録 → 公開カタログ → 実リクエストまで通す。
// 実 LLM は呼ばず、送信ヘッダ (Authorization) とパスだけを検証する。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPiBff } from "../src/agent";
import { createBffApp } from "../src/app";

const KEY = "sk-custom-dummy-key-0123456789";

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

/** OpenAI 互換の chat/completions だけを返す fake。届いたヘッダとパスを記録する */
async function startFakeOpenAi(): Promise<{ server: Server; baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body: text ? JSON.parse(text) : undefined,
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      chunk({
        id: "chatcmpl-custom",
        object: "chat.completion.chunk",
        created: 1,
        model: "qwen2.5-coder:7b",
        choices: [{ index: 0, delta: { role: "assistant", content: "こんにちは" }, finish_reason: null }],
      });
      chunk({
        id: "chatcmpl-custom",
        object: "chat.completion.chunk",
        created: 1,
        model: "qwen2.5-coder:7b",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

test("登録したカスタム provider は公開カタログに available で載り、送信は Authorization: Bearer で fake へ届く", async () => {
  const fake = await startFakeOpenAi();
  const agentDir = mkdtempSync(join(tmpdir(), "u7agent-custom-provider-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "u7agent-custom-provider-cwd-"));
  const sessionStoreDir = mkdtempSync(join(tmpdir(), "u7agent-custom-provider-store-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let bff: Awaited<ReturnType<typeof createBffApp>> | undefined;
  try {
    const pi = await createPiBff({ cwd });
    bff = await createBffApp({ cwd, sessionStoreDir, pi, workspace: null });

    const created = await bff.app.request("/api/settings/custom-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "local-llm",
        name: "Local LLM",
        baseUrl: fake.baseUrl,
        apiKey: KEY,
        model: { id: "qwen2.5-coder:7b", contextWindow: 32768 },
      }),
    });
    assert.equal(created.status, 200);
    assert.equal(((await created.json()) as any).state, "applied");

    const catalog = (await (await bff.app.request("/api/runtime/models")).json()) as any;
    const provider = catalog.providers.find((entry: any) => entry.provider === "local-llm");
    assert.ok(provider, "GET /api/runtime/models に provider が載る");
    assert.deepEqual(provider.auth, { configured: true, source: "runtime", environmentVariables: [] });
    assert.deepEqual(provider.models, [{ id: "qwen2.5-coder:7b", name: "qwen2.5-coder:7b", available: true }]);
    assert.equal(catalog.availableCount, 1);

    const model = pi.modelRuntime.getModels().find((entry) => entry.provider === "local-llm");
    assert.ok(model, "SDK のカタログにもモデルが載る");
    const message = await pi.modelRuntime.completeSimple(
      model,
      {
        systemPrompt: "短く答えてください",
        messages: [{ role: "user", content: [{ type: "text", text: "こんにちは" }], timestamp: Date.now() }],
      },
      { maxTokens: 16 },
    );
    assert.equal(message.stopReason, "stop");
    assert.deepEqual(
      message.content.map((block) => (block.type === "text" ? block.text : block.type)),
      ["こんにちは"],
    );

    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].method, "POST");
    assert.equal(fake.requests[0].url, "/v1/chat/completions");
    assert.equal(fake.requests[0].authorization, `Bearer ${KEY}`, "runtime overlay のキーを Bearer で送る");
    // What: 上流の `model` はモデル ID だけ。provider id を接頭しない (待ち受けはモデル名だけを受ける)
    assert.equal(
      (fake.requests[0].body as { model?: string }).model,
      "qwen2.5-coder:7b",
      "上流へは provider id を付けず、モデル ID をそのまま送る",
    );

    // 削除後はカタログから外れ、同じ id の再登録に古い overlay が残らない
    const deleted = await bff.app.request("/api/settings/custom-providers/local-llm", { method: "DELETE" });
    assert.equal(deleted.status, 200);
    const afterDelete = (await (await bff.app.request("/api/runtime/models")).json()) as any;
    assert.equal(
      afterDelete.providers.find((entry: any) => entry.provider === "local-llm"),
      undefined,
    );

    const recreated = await bff.app.request("/api/settings/custom-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "local-llm",
        // What: 名前を空欄にすると provider の表示名は provider id になり、モデル ID には付かない
        baseUrl: fake.baseUrl,
        apiKey: KEY,
        model: { id: "qwen2.5-coder:7b", contextWindow: 32768 },
      }),
    });
    assert.equal(recreated.status, 200);
    const unnamed = (await (await bff.app.request("/api/settings/models")).json()) as any;
    assert.equal(
      unnamed.providers.find((entry: any) => entry.provider === "local-llm")?.name,
      "local-llm",
      "名前が空欄なら provider id を表示名にする",
    );
    const unnamedModel = pi.modelRuntime.getModels().find((entry) => entry.provider === "local-llm");
    assert.ok(unnamedModel);
    assert.equal(unnamedModel.name, "qwen2.5-coder:7b", "モデルの表示名も provider id を付けない");
    await pi.modelRuntime.completeSimple(
      unnamedModel,
      { messages: [{ role: "user", content: [{ type: "text", text: "こんにちは" }], timestamp: Date.now() }] },
      { maxTokens: 16 },
    );
    assert.equal(
      (fake.requests[1].body as { model?: string }).model,
      "qwen2.5-coder:7b",
      "名前が空欄でも上流の model はモデル ID のまま",
    );
    assert.equal(
      pi.modelRuntime.getProviderAuthStatus("local-llm")?.source,
      "runtime",
      "再登録したキーが runtime overlay として効く",
    );
  } finally {
    await bff?.close();
    fake.server.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    for (const dir of [agentDir, cwd, sessionStoreDir]) rmSync(dir, { recursive: true, force: true });
  }
});
