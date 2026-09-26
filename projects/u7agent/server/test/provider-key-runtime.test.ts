// SDK の操作結果を CredentialCommit へ写す境界 (server/src/bootstrap.ts) の検証。
// CSE は「Map への commit 後に同期が失敗」の印なので、provider / operation を照合して未適用と断定しない。
import assert from "node:assert/strict";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import type { PiBff } from "../src/agent";
import { createProviderKeyRuntime } from "../src/bootstrap";
import type { CredentialCommit } from "../src/model-settings";

const KEY = "sk-ant-dummy-key-0123456789abcdef";

function cse(providerId: string, operation: "setRuntimeApiKey" | "removeRuntimeApiKey", message: string) {
  return new CredentialSynchronizationError(
    providerId,
    operation,
    { type: "api_key", key: KEY },
    {
      cause: new Error(message),
    },
  );
}

function fakePi(options: {
  providers?: { id: string; name?: string; apiKeyLogin?: boolean; oauth?: boolean }[];
  set?: (signal?: AbortSignal) => Promise<unknown>;
  remove?: (signal?: AbortSignal) => Promise<unknown>;
}) {
  const setCalls: (AbortSignal | undefined)[] = [];
  const removeCalls: (AbortSignal | undefined)[] = [];
  const modelRuntime = {
    getProviders: () =>
      (options.providers ?? [{ id: "anthropic", name: "Anthropic", apiKeyLogin: true }]).map((provider) => ({
        id: provider.id,
        name: provider.name ?? provider.id,
        auth: {
          apiKey: provider.apiKeyLogin === false ? undefined : { name: `${provider.id} key`, login: () => {} },
          oauth: provider.oauth ? {} : undefined,
        },
      })),
    getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
    setRuntimeApiKey: async (_provider: string, _apiKey: string, callOptions?: { signal?: AbortSignal }) => {
      setCalls.push(callOptions?.signal);
      await options.set?.(callOptions?.signal);
    },
    removeRuntimeApiKey: async (_provider: string, callOptions?: { signal?: AbortSignal }) => {
      removeCalls.push(callOptions?.signal);
      await options.remove?.(callOptions?.signal);
    },
  };
  return { pi: { modelRuntime } as unknown as PiBff, setCalls, removeCalls };
}

function bodyOf(commit: CredentialCommit): string {
  return `${commit.outcome}:${commit.outcome === "applied" ? commit.synced : ""}`;
}

test("resolve は applied/synced になる", async () => {
  const { pi } = fakePi({});
  assert.equal(
    bodyOf(await createProviderKeyRuntime(pi).applyApiKey("anthropic", KEY, { signal: new AbortController().signal })),
    "applied:true",
  );
});

test("provider と operation が一致する CSE だけを commit 済みと判定する", async () => {
  const applyRuntime = createProviderKeyRuntime(
    fakePi({
      set: () => Promise.reject(cse("anthropic", "setRuntimeApiKey", `boom ${KEY}`)),
    }).pi,
  );
  assert.equal(
    bodyOf(await applyRuntime.applyApiKey("anthropic", KEY, { signal: new AbortController().signal })),
    "applied:false",
  );

  const removed = createProviderKeyRuntime(
    fakePi({ remove: () => Promise.reject(cse("anthropic", "removeRuntimeApiKey", "boom")) }).pi,
  );
  assert.equal(
    bodyOf(await removed.removeApiKey("anthropic", { signal: new AbortController().signal })),
    "applied:false",
  );

  // provider 不一致 / operation 不一致は commit の有無を断定しない
  const otherProvider = createProviderKeyRuntime(
    fakePi({ set: () => Promise.reject(cse("openai", "setRuntimeApiKey", "boom")) }).pi,
  );
  assert.equal(
    bodyOf(await otherProvider.applyApiKey("anthropic", KEY, { signal: new AbortController().signal })),
    "unknown:",
  );

  const otherOperation = createProviderKeyRuntime(
    fakePi({ set: () => Promise.reject(cse("anthropic", "removeRuntimeApiKey", "boom")) }).pi,
  );
  assert.equal(
    bodyOf(await otherOperation.applyApiKey("anthropic", KEY, { signal: new AbortController().signal })),
    "unknown:",
  );
});

test("開始前に abort 済みなら not_applied として SDK を呼ばない", async () => {
  const { pi, setCalls } = fakePi({ set: () => Promise.resolve() });
  const controller = new AbortController();
  controller.abort();
  const commit = await createProviderKeyRuntime(pi).applyApiKey("anthropic", KEY, { signal: controller.signal });
  assert.equal(bodyOf(commit), "not_applied:");
  assert.deepEqual(setCalls, [], "SDK の Map に触っていない");
});

test("実行中 abort / timeout は unknown に倒し、未適用と断定しない", async () => {
  const { pi } = fakePi({
    set: async (signal) => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      if (signal?.aborted) throw abortError;
      throw abortError;
    },
  });
  const controller = new AbortController();
  const pending = createProviderKeyRuntime(pi).applyApiKey("anthropic", KEY, { signal: controller.signal });
  controller.abort();
  assert.equal(bodyOf(await pending), "unknown:");
});

test("未知の例外は unknown にする", async () => {
  const { pi } = fakePi({ set: () => Promise.reject(new Error(`unexpected ${KEY}`)) });
  assert.equal(
    bodyOf(await createProviderKeyRuntime(pi).applyApiKey("anthropic", KEY, { signal: new AbortController().signal })),
    "unknown:",
  );
});

test("list は auth.apiKey.login の有無で canSetApiKey を決め、auth は SDK の状態をそのまま読む", () => {
  const { pi } = fakePi({
    providers: [
      { id: "anthropic", name: "Anthropic", apiKeyLogin: true, oauth: true },
      { id: "local", apiKeyLogin: false },
    ],
  });
  const runtime = createProviderKeyRuntime(pi);
  assert.deepEqual(runtime.list(), [
    { provider: "anthropic", name: "Anthropic", canSetApiKey: true, supportsOAuth: true },
    { provider: "local", name: "local", canSetApiKey: false, supportsOAuth: false },
  ]);
  assert.deepEqual(runtime.auth("anthropic"), { configured: true, source: "environment" });
});
