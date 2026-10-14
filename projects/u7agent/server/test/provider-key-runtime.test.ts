// SDK の操作結果を CredentialCommit へ写す境界 (server/src/bootstrap.ts) の検証。
// CSE は「Map への commit 後に同期が失敗」の印なので、provider / operation を照合して未適用と断定しない。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  providers?: {
    id: string;
    name?: string;
    apiKeyLogin?: boolean;
    oauth?: boolean;
    oauthLoginLabel?: string;
    usingOAuth?: boolean;
  }[];
  /** auth.json を置く agent dir。未指定なら存在しないパスを指し、保存値は「不明」になる */
  agentDir?: string;
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
          oauth: provider.oauth ? { loginLabel: provider.oauthLoginLabel } : undefined,
        },
      })),
    getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
    isUsingOAuth: (providerId: string) =>
      (options.providers ?? []).some((provider) => provider.id === providerId && provider.usingOAuth === true),
    setRuntimeApiKey: async (_provider: string, _apiKey: string, callOptions?: { signal?: AbortSignal }) => {
      setCalls.push(callOptions?.signal);
      await options.set?.(callOptions?.signal);
    },
    removeRuntimeApiKey: async (_provider: string, callOptions?: { signal?: AbortSignal }) => {
      removeCalls.push(callOptions?.signal);
      await options.remove?.(callOptions?.signal);
    },
  };
  const agentDir = options.agentDir ?? join(tmpdir(), "u7agent-no-such-agent-dir");
  return { pi: { modelRuntime, agentDir } as unknown as PiBff, setCalls, removeCalls };
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

test("list は canSetApiKey を auth.apiKey.login で、サインインの可否を許可リストで決める", () => {
  const { pi } = fakePi({
    providers: [
      { id: "anthropic", name: "Anthropic", apiKeyLogin: true, oauth: true },
      { id: "openai", name: "OpenAI", apiKeyLogin: true, oauth: true, oauthLoginLabel: "Sign in with ChatGPT" },
      { id: "local", apiKeyLogin: false },
    ],
  });
  const runtime = createProviderKeyRuntime(pi);
  // サインインの可否は許可リスト (oauth-login) が決める。OAuth を持つのにここで完了できない provider は false
  assert.deepEqual(runtime.list(), [
    {
      provider: "anthropic",
      name: "Anthropic",
      canSetApiKey: true,
      supportsOAuth: true,
      canSignInHere: false,
      oauthLoginLabel: null,
    },
    {
      provider: "openai",
      name: "OpenAI",
      canSetApiKey: true,
      supportsOAuth: true,
      canSignInHere: true,
      oauthLoginLabel: "Sign in with ChatGPT",
    },
    {
      provider: "local",
      name: "local",
      canSetApiKey: false,
      supportsOAuth: false,
      canSignInHere: false,
      oauthLoginLabel: null,
    },
  ]);
  assert.deepEqual(runtime.auth("anthropic"), { configured: true, source: "environment" });
});

test("credentialKind は SDK の isUsingOAuth を写し、storedCredentialKind は auth.json の種別だけを読む", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "u7agent-provider-key-runtime-"));
  try {
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({
        openai: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 60_000 },
        anthropic: { type: "api_key", key: KEY },
      }),
    );
    const { pi } = fakePi({
      agentDir,
      providers: [
        { id: "openai", oauth: true, usingOAuth: true },
        { id: "anthropic", apiKeyLogin: true, usingOAuth: false },
      ],
    });
    const runtime = createProviderKeyRuntime(pi);
    assert.equal(runtime.credentialKind("openai"), "oauth");
    assert.equal(runtime.credentialKind("anthropic"), "api_key");
    assert.deepEqual(
      [runtime.storedCredentialKind("openai"), runtime.storedCredentialKind("anthropic")],
      ["oauth", "api_key"],
      "auth.json の保存値は種別だけを返す",
    );
    assert.equal(runtime.storedCredentialKind("xai"), undefined, "保存が無い provider は不明");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("storedCredentialKind は auth.json を読めないとき不明へ縮退する", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "u7agent-provider-key-runtime-"));
  try {
    writeFileSync(join(agentDir, "auth.json"), "{ not json");
    const runtime = createProviderKeyRuntime(fakePi({ agentDir }).pi);
    assert.equal(runtime.storedCredentialKind("openai"), undefined);
    rmSync(join(agentDir, "auth.json"), { force: true });
    assert.equal(runtime.storedCredentialKind("openai"), undefined, "読取失敗も不明へ寄せる");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
