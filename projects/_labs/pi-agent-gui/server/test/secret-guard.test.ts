import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSecretMasker, REDACTED } from "../src/redact";
import {
  collectSecretValues,
  createGuardedShellToolDefinitions,
  createSecretRedactionExtension,
  extraSecretVarNames,
  wrapToolDefinitionWithSecretMasker,
} from "../src/secret-guard";

const KEY = "sk-guard-dummy-0123456789abcdef";
const OPENAI_DUMMY = "sk-openai-dummy-0123456789";
const CUSTOM_DUMMY = "custom-secret-0123456789";
const DUMMY_ENV_VAR = "DUMMY_GUARD_PROVIDER_API_KEY";
const HAS_BASH = existsSync("/bin/bash");
const SKIP_REASON = "bash is not available on this platform";

function withTempEnv(name: string, value: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return run().finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
}

test("collectSecretValues gathers configured provider env values only", () => {
  const env = {
    OPENAI_API_KEY: OPENAI_DUMMY,
    ANTHROPIC_API_KEY: "",
    CUSTOM_KEY: CUSTOM_DUMMY,
    UNRELATED: "just-a-shell-value-but-long-enough",
  };
  const values = collectSecretValues(
    [{ id: "openai" }, { id: "anthropic" }, { id: "unknown-provider" }],
    env,
    ["CUSTOM_KEY"],
  );
  assert.deepEqual([...values].sort(), [CUSTOM_DUMMY, OPENAI_DUMMY].sort());
});

test("collectSecretValues supplements provider auth vars that findEnvKeys misses", () => {
  const bearer = "aws-bearer-dummy-0123456789";
  const values = collectSecretValues([{ id: "amazon-bedrock" }], { AWS_BEARER_TOKEN_BEDROCK: bearer });
  assert.deepEqual(values, [bearer]);
});

test("collectSecretValues floors auto-discovered short values but protects explicit ones", () => {
  // 自動解決: findEnvKeys が見付けた変数でも 8 文字未満の値は対象外
  const auto = collectSecretValues([{ id: "openai" }], { OPENAI_API_KEY: "short" });
  assert.deepEqual(auto, []);
  // 明示指定: 同じ変数名でも PI_SECRET_ENV_VARS に入っていれば長さに関係なく保護
  const explicit = collectSecretValues([{ id: "openai" }], { OPENAI_API_KEY: "short" }, ["OPENAI_API_KEY"]);
  assert.deepEqual(explicit, ["short"]);
  // 明示指定した長い値も通常どおり保護される
  const longExplicit = collectSecretValues([{ id: "openai" }], { CUSTOM_KEY: "abc" }, ["CUSTOM_KEY"]);
  assert.deepEqual(longExplicit, ["abc"]);
});

test("extraSecretVarNames parses PI_SECRET_ENV_VARS and drops invalid names", () => {
  assert.deepEqual(extraSecretVarNames({ PI_SECRET_ENV_VARS: " MY_KEY , 9bad,ok_name " }), [
    "MY_KEY",
    "ok_name",
  ]);
  assert.deepEqual(extraSecretVarNames({}), []);
});

test("guarded bash tool runs normal commands with an allowlisted environment", { skip: !HAS_BASH && SKIP_REASON }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-guard-"));
  const [definition] = createGuardedShellToolDefinitions(cwd, createSecretMasker([KEY]));
  await withTempEnv(DUMMY_ENV_VAR, KEY, async () => {
    await withTempEnv("BASH_ENV", "/tmp/pi-guard-profile-that-must-not-load", async () => {
      const result = await definition.execute(
        "t1",
        { command: "env; echo done-$?" },
        undefined,
        undefined,
        undefined as never,
      );
      const text = toolText(result);
      assert.ok(!text.includes(KEY), "provider key must not reach the child environment");
      assert.ok(!text.includes("BASH_ENV="), "BASH_ENV must not be inherited");
      assert.match(text, /^PATH=/m, "PATH must be present");
      assert.ok(text.includes("done-0"), `normal command failed: ${text}`);
    });
  });
});

test("guarded bash tool keeps SDK session metadata variables", { skip: !HAS_BASH && SKIP_REASON }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-guard-"));
  const [definition] = createGuardedShellToolDefinitions(cwd, createSecretMasker([]));
  const ctx = {
    cwd,
    sessionManager: {
      getSessionId: () => "pi-session-id",
      getSessionFile: () => undefined,
    },
    model: { provider: "stub", id: "stub-model" },
    thinkingLevel: "low",
  } as never;
  const result = await definition.execute(
    "t2",
    { command: "printenv PI_SESSION_ID PI_PROVIDER PI_MODEL" },
    undefined,
    undefined,
    ctx,
  );
  const text = toolText(result);
  assert.match(text, /pi-session-id/);
  assert.match(text, /stub/);
});

test("guarded bash tool masks key values that appear in command output", { skip: !HAS_BASH && SKIP_REASON }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-guard-"));
  const [definition] = createGuardedShellToolDefinitions(cwd, createSecretMasker([KEY]));
  const result = await definition.execute(
    "t3",
    { command: `echo "token=${KEY}"` },
    undefined,
    undefined,
    undefined as never,
  );
  const text = toolText(result);
  assert.ok(!text.includes(KEY), "raw key must not appear in tool output");
  assert.ok(text.includes(`token=${REDACTED}`), `masked output expected, got: ${text}`);
});

test("shell tool wrapper masks partial updates, final output, and errors", async () => {
  const masker = createSecretMasker([KEY]);
  type FakeDefinition = Parameters<typeof wrapToolDefinitionWithSecretMasker>[0];
  const inner = {
    name: "fake-shell",
    label: "Fake",
    description: "fake",
    parameters: {},
    async execute(
      _id: string,
      _params: unknown,
      _signal: unknown,
      onUpdate?: (update: { content: unknown }) => void,
    ) {
      onUpdate?.({ content: [{ type: "text", text: `partial ${KEY.slice(0, 6)}` }] });
      onUpdate?.({ content: [{ type: "text", text: `full ${KEY}` }] });
      throw new Error(`boom ${KEY}`);
    },
  } as unknown as FakeDefinition;

  const wrapped = wrapToolDefinitionWithSecretMasker(inner, masker);
  const updates: Array<{ content: Array<{ type: string; text?: string }> }> = [];
  await assert.rejects(
    wrapped.execute("t4", {}, undefined, (update) => updates.push(update as never), undefined as never),
    (error: Error) => {
      assert.equal(error.message, `boom ${REDACTED}`);
      return true;
    },
  );
  assert.equal(updates.length, 2);
  // 途中出力: 前方一致の末尾は保留され、完全体はマスクされる
  assert.equal(updates[0].content[0].text, "partial ");
  assert.equal(updates[1].content[0].text, `full ${REDACTED}`);
});

test("redaction extension masks tool_result content before it reaches the LLM", async () => {
  const registered = new Map<string, (event: never) => Promise<unknown>>();
  const extension = createSecretRedactionExtension(createSecretMasker([KEY])) as (pi: never) => Promise<void>;
  await extension({
    on: (name: string, handler: never) => {
      registered.set(name, handler);
    },
  } as never);

  const handler = registered.get("tool_result");
  assert.ok(handler, "tool_result handler must be registered");
  const imagePart = { type: "image", data: "Zm9v", mimeType: "image/png" };
  const result = (await handler({
    content: [{ type: "text", text: `read ${KEY} end` }, imagePart],
  } as never)) as { content: Array<{ type: string; text?: string }> };
  assert.equal(result.content[0].text, `read ${REDACTED} end`);
  assert.equal(result.content[1], imagePart, "non-text parts must be untouched");
});

test("redaction extension leaves content without secrets untouched", async () => {
  const registered = new Map<string, (event: never) => Promise<unknown>>();
  const extension = createSecretRedactionExtension(createSecretMasker([KEY])) as (pi: never) => Promise<void>;
  await extension({
    on: (name: string, handler: never) => {
      registered.set(name, handler);
    },
  } as never);
  const handler = registered.get("tool_result");
  assert.ok(handler);
  const content = [{ type: "text", text: "total 48\ndrwxr-x--- 8 node node 4096 .\n" }];
  const result = (await handler({ content } as never)) as { content: unknown };
  assert.deepEqual(result.content, content);
});
