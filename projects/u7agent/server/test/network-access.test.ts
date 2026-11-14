// egress ポリシーの契約: モード解決 / 承認のメモリ / 許可ポートの切り替え / 承認ツール / 投影 / 回答の往復。
// 実ネットワークへは出ない (サンドボックスの Landlock は landlock-exec.py 側の検査で担保する)。
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { validateAskUserAnswers } from "../src/ask-user-tool";
import { NetworkAccessApprovals, networkAccessMode } from "../src/network-access";
import {
  REQUEST_NETWORK_ACCESS_TOOL_NAME,
  createRequestNetworkAccessToolDefinitions,
  deriveNetworkAccessQuestions,
  networkAccessQuestions,
  withRequestNetworkAccessTool,
  type NetworkAccessHost,
} from "../src/request-network-access-tool";
import { LANDLOCK_ALLOWED_PORTS, LANDLOCK_PORTS_WITHOUT_HTTPS, landlockAllowedPorts } from "../src/sandbox/landlock";
import type { AskUserAnswer, AskUserQuestion } from "../src/schema";
import { askUserAnswersOf, askUserQuestionsOf } from "../src/session-projection";
import { createSecretMasker } from "../src/redact";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SessionStore, type PiRuntimeLike, type PiSessionLike } from "../src/sessions";

const CWD = "/tmp/project";
const masker = createSecretMasker([]);

/** 実 SDK と同じく、渡された id をそのままセッション id にする */
function sessionStub(sessionId = "pi-network-access"): PiSessionLike {
  return {
    sessionId,
    model: { provider: "stub", id: "stub-model" },
    thinkingLevel: "low",
    messages: [],
    isStreaming: false,
    disposed: false,
    get isIdle() {
      return true;
    },
    supportsThinking: () => true,
    getAvailableThinkingLevels: () => ["low"],
    setThinkingLevel() {},
    async setModel() {},
    subscribe() {
      return () => {};
    },
    async abort() {},
    dispose() {},
    async prompt() {},
  } as unknown as PiSessionLike;
}

function createStore(options: { storeDir?: string } = {}): SessionStore {
  return new SessionStore({
    pi: {
      createSession: async (input?: { sessionId?: string }) => ({ session: sessionStub(input?.sessionId) }),
    } as unknown as PiRuntimeLike,
    catalog: createAgentCatalog(),
    masker,
    rootCwd: CWD,
    ...(options.storeDir === undefined
      ? {}
      : {
          storeDir: options.storeDir,
          // 永続化すると作業フォルダの作成が要る。実ファイルは使わないので、呼び出しだけ受ける
          workspace: { createDir: async (path: string) => ({ path }) } as unknown as SandboxWorkspaceClient,
        }),
  });
}

/** 承認の質問を返すだけのホスト。`ask` の呼び出し回数を記録する */
function createHost(options: {
  mode?: "allow" | "ask" | "deny";
  answers?: AskUserAnswer[];
  reject?: boolean;
}): NetworkAccessHost & { calls: number } {
  const host = {
    calls: 0,
    allows: () => false,
    mode: () => options.mode ?? "ask",
    async ask(): Promise<AskUserAnswer[]> {
      host.calls += 1;
      if (options.reject) throw new Error("aborted");
      return options.answers ?? [{ index: 0, approval: true }];
    },
  };
  return host;
}

test("モードは env から解決し、未知の値は allow に倒す", () => {
  assert.equal(networkAccessMode(undefined), "allow");
  assert.equal(networkAccessMode(""), "allow");
  assert.equal(networkAccessMode("  ALLOW  "), "allow");
  assert.equal(networkAccessMode("ask"), "ask");
  assert.equal(networkAccessMode(" ASK "), "ask");
  assert.equal(networkAccessMode("deny"), "deny");
  // 設定ミスで bash の通信を止めない (既定は後方互換の allow)
  assert.equal(networkAccessMode("block"), "allow");
  assert.equal(networkAccessMode("1"), "allow");
});

test("承認はセッション単位で、モードごとに allow / ask / deny の意味が変わる", () => {
  const approvals = new NetworkAccessApprovals();
  assert.equal(approvals.allows("a", "allow"), true);
  assert.equal(approvals.allows("a", "ask"), false);
  assert.equal(approvals.allows("a", "deny"), false);

  approvals.approve("a");
  assert.equal(approvals.allows("a", "ask"), true);
  // deny は承認しても開かない
  assert.equal(approvals.allows("a", "deny"), false);
  // 別セッションへ漏れない
  assert.equal(approvals.allows("b", "ask"), false);

  approvals.revoke("a");
  assert.equal(approvals.allows("a", "ask"), false);
  assert.equal(approvals.isApproved("a"), false);
});

test("許可ポートは networkAccess が偽のときだけ 443 を落とす", () => {
  assert.equal(landlockAllowedPorts(true), LANDLOCK_ALLOWED_PORTS);
  assert.equal(landlockAllowedPorts(false), LANDLOCK_PORTS_WITHOUT_HTTPS);
  assert.match(LANDLOCK_ALLOWED_PORTS, /(^|,)443(,|$)/);
  assert.doesNotMatch(LANDLOCK_PORTS_WITHOUT_HTTPS, /(^|,)443(,|$)/);
  // ローカルサーバーと同梱ブラウザは承認と無関係に使える
  for (const port of ["8080", "18000-18099", "18100-18199"]) {
    assert.match(LANDLOCK_PORTS_WITHOUT_HTTPS, new RegExp(port.replace("-", "\\-")));
  }
});

test("承認の質問は reason から固定 1 問を組み立て、選択肢は BFF が決める", () => {
  const [question] = networkAccessQuestions("registry.npmjs.org から依存を取る");
  assert.equal(question?.type, "choice");
  assert.equal(question?.multiSelect, undefined);
  assert.deepEqual(
    question?.options?.map((option) => option.label),
    ["許可", "拒否"],
  );
  assert.match(question?.question ?? "", /この通信を許可しますか？/);
  assert.match(question?.question ?? "", /registry\.npmjs\.org から依存を取る/);
  // reason の省略は空文字と同じ (説明の無い承認要求を許す)
  assert.deepEqual(deriveNetworkAccessQuestions({}), networkAccessQuestions(""));
  assert.equal(deriveNetworkAccessQuestions({ reason: 1 }), undefined);
  assert.equal(deriveNetworkAccessQuestions(null), undefined);
  // 長すぎる reason は質問文の上限で切る
  const [long] = networkAccessQuestions("x".repeat(1000));
  assert.equal(long?.question.length, "この通信を許可しますか？\n\n".length + 500);
});

test("接続先は host 引数を正規化して持ち、未指定なら reason から拾う", () => {
  const [direct] = networkAccessQuestions("記事を取得する", "https://ja.wikipedia.org/wiki/x?q=1");
  assert.equal(direct?.host, "ja.wikipedia.org");
  assert.equal(direct?.header, "外部通信の許可");
  // ポートはチップに出さない (承認で開くのは 443 だけ)
  assert.equal(networkAccessQuestions("記事を取得する", "example.com:8443")[0]?.host, "example.com");
  // 資格情報は接続先として出さない
  assert.equal(
    networkAccessQuestions("記事を取得する", "https://user:pass@example.com:8443/private")[0]?.host,
    "example.com",
  );
  assert.equal(networkAccessQuestions("記事を取得する", "not a host")[0]?.host, undefined);
  // 理由文にだけホストがある旧い要求でも、接続先のチップを出せる
  assert.equal(networkAccessQuestions("ja.wikipedia.org の記事を取得する")[0]?.host, "ja.wikipedia.org");
  assert.equal(networkAccessQuestions("記事を取得する")[0]?.host, undefined);
  assert.deepEqual(
    deriveNetworkAccessQuestions({ reason: "記事を取得する", host: "ja.wikipedia.org" }),
    networkAccessQuestions("記事を取得する", "ja.wikipedia.org"),
  );
  assert.equal(deriveNetworkAccessQuestions({ reason: "r", host: 1 }), undefined);
});

test("allow と deny では質問せず、ask だけがホストへ委譲する", async () => {
  const allowHost = createHost({ mode: "allow" });
  const [allowTool] = createRequestNetworkAccessToolDefinitions({
    enabled: true,
    sessionId: () => "s1",
    host: allowHost,
  });
  const allowResult = (await allowTool?.execute("call-1", { reason: "r" }, undefined, undefined, {} as never)) as {
    content: { text?: string }[];
    details: { answers: AskUserAnswer[] };
    isError?: boolean;
  };
  assert.equal(allowHost.calls, 0);
  assert.match(allowResult.content[0]?.text ?? "", /常に許可/);
  assert.equal(allowResult.isError, undefined);

  const denyHost = createHost({ mode: "deny" });
  const [denyTool] = createRequestNetworkAccessToolDefinitions({
    enabled: true,
    sessionId: () => "s1",
    host: denyHost,
  });
  const denyResult = (await denyTool?.execute("call-1", { reason: "r" }, undefined, undefined, {} as never)) as {
    isError?: boolean;
  };
  assert.equal(denyHost.calls, 0);
  assert.equal(denyResult.isError, true);

  const askHost = createHost({ mode: "ask", answers: [{ index: 0, approval: false }] });
  const [askTool] = createRequestNetworkAccessToolDefinitions({ enabled: true, sessionId: () => "s1", host: askHost });
  const askResult = (await askTool?.execute("call-1", { reason: "r" }, undefined, undefined, {} as never)) as {
    content: { text?: string }[];
    details: { questions: AskUserQuestion[]; answers: AskUserAnswer[] };
  };
  assert.equal(askHost.calls, 1);
  assert.match(askResult.content[0]?.text ?? "", /拒否/);
  assert.deepEqual(askResult.details.answers, [{ index: 0, approval: false }]);
  assert.equal(askResult.details.questions.length, 1);
});

test("承認待ちの停止では details を残し、承認は確定しない", async () => {
  const host = createHost({ mode: "ask", reject: true });
  const [tool] = createRequestNetworkAccessToolDefinitions({ enabled: true, sessionId: () => "s1", host });
  const result = (await tool?.execute("call-1", { reason: "r" }, undefined, undefined, {} as never)) as {
    content: { text?: string }[];
    details: { answers: AskUserAnswer[] };
    isError?: boolean;
  };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /停止/);
  assert.deepEqual(result.details.answers, []);
});

test("登録名は enabled のときだけ足す", () => {
  assert.deepEqual(withRequestNetworkAccessTool(["read"], true), ["read", REQUEST_NETWORK_ACCESS_TOOL_NAME]);
  assert.deepEqual(withRequestNetworkAccessTool(["read"], false), ["read"]);
});

test("投影は reason から同じ質問を出し、承認の真偽を落とさない", () => {
  const questions = askUserQuestionsOf(REQUEST_NETWORK_ACCESS_TOOL_NAME, { reason: "r" }, masker);
  assert.equal(questions?.length, 1);
  assert.match(questions?.[0]?.question ?? "", /この通信を許可しますか？/);

  assert.deepEqual(
    askUserAnswersOf(REQUEST_NETWORK_ACCESS_TOOL_NAME, { answers: [{ index: 0, approval: true }] }, masker),
    [{ index: 0, approval: true }],
  );
  // false を undefined (未回答) と混同しない
  assert.deepEqual(
    askUserAnswersOf(REQUEST_NETWORK_ACCESS_TOOL_NAME, { answers: [{ index: 0, approval: false }] }, masker),
    [{ index: 0, approval: false }],
  );
  // ask_user の投影は従来どおり
  assert.equal(askUserQuestionsOf("ask_user", { questions: [{ question: "q" }] }, masker)?.length, 1);
  assert.equal(askUserAnswersOf("ask_user", { answers: [{ index: 0, text: "a" }] }, masker)?.[0]?.text, "a");
});

test("承認の投影は host / reason を正規化の前にマスクし、資格情報を DTO に残さない", () => {
  const secret = "https://sample-user:dummy-secret-value@registry.example.com/private";
  const secretMasker = createSecretMasker([secret]);

  const fromHost = askUserQuestionsOf(
    REQUEST_NETWORK_ACCESS_TOOL_NAME,
    { host: secret, reason: "依存取得" },
    secretMasker,
  );
  assert.equal(fromHost?.length, 1);
  assert.doesNotMatch(JSON.stringify(fromHost), /dummy-secret-value|sample-user/);

  // 理由文の秘密 URL も、正規化より前にマスクしてからホスト名を拾う
  const fromReason = askUserQuestionsOf(
    REQUEST_NETWORK_ACCESS_TOOL_NAME,
    { reason: `${secret} を registry.example.com から取る` },
    secretMasker,
  );
  assert.doesNotMatch(JSON.stringify(fromReason), /dummy-secret-value|sample-user/);
  assert.equal(fromReason?.[0]?.host, "registry.example.com");
});

test("承認は承認ツールの回答だけで受け付け、他の項目とは排他", () => {
  const questions: AskUserQuestion[] = [{ question: "この通信を許可しますか？", type: "choice" }];
  assert.equal(validateAskUserAnswers(questions, [{ index: 0, approval: true }], "network_access"), undefined);
  assert.equal(validateAskUserAnswers(questions, [{ index: 0, approval: false }], "network_access"), undefined);
  // 回答しないも「未承認」として通す
  assert.equal(validateAskUserAnswers(questions, [{ index: 0, skipped: true }], "network_access"), undefined);
  assert.match(validateAskUserAnswers(questions, [{ index: 0 }], "network_access") ?? "", /needs approval/);
  assert.match(
    validateAskUserAnswers(questions, [{ index: 0, approval: true, text: "x" }], "network_access") ?? "",
    /cannot be combined/,
  );
  // ask_user 側に approval が来たら 400
  assert.match(validateAskUserAnswers(questions, [{ index: 0, approval: true }], "ask_user") ?? "", /only accepted/);
  // 既存の ask_user は selected + text の同時指定を引き続き通す
  assert.equal(validateAskUserAnswers(questions, [{ index: 0, selected: ["A"], text: "補足" }]), undefined);
});

test("承認は回答の受理時に記録し、拒否・停止・削除で未承認へ戻る", async () => {
  const store = createStore();
  const record = await store.create();
  const host = store.networkAccessHost();
  assert.equal(host.mode(), "allow");

  // 承認ツールの待機を開き、approval: true で承認される
  const questions = networkAccessQuestions("r");
  const pending = host.ask(record.id, "call-1", questions, undefined);
  assert.equal(store.answerQuestion(record, "call-1", [{ index: 0, approval: true }]).status, "ok");
  assert.deepEqual(await pending, [{ index: 0, approval: true }]);
  assert.equal(store.networkAccess.isApproved(record.id), true);

  // ask_user の待機に approval を送ると 400 (種別は pending 側で決まる)
  const asked = store.askUserHost().ask(record.id, "call-2", [{ question: "q" }], undefined);
  const rejected = store.answerQuestion(record, "call-2", [{ index: 0, approval: true }]);
  assert.equal(rejected.status, "invalid");
  store.answerQuestion(record, "call-2", [{ index: 0, text: "ok" }]);
  await asked;

  // 拒否で未承認へ戻る
  const denied = host.ask(record.id, "call-3", questions, undefined);
  store.answerQuestion(record, "call-3", [{ index: 0, approval: false }]);
  await denied;
  assert.equal(store.networkAccess.isApproved(record.id), false);

  // 承認 → 停止で未承認
  store.networkAccess.approve(record.id);
  await store.stop(record);
  assert.equal(store.networkAccess.isApproved(record.id), false);

  // 承認 → 削除で未承認 (record は消えるが、同じ id の再利用へ持ち越さない)
  store.networkAccess.approve(record.id);
  await store.deleteSession(record.id);
  assert.equal(store.networkAccess.isApproved(record.id), false);
});

test("別セッションの承認は混ざらず、承認の無いセッションは開かない", async () => {
  // モードは env 由来なので、ask の間だけ差し替えて戻す (他のテストへ漏らさない)
  const previous = process.env.PI_SANDBOX_NETWORK_POLICY;
  process.env.PI_SANDBOX_NETWORK_POLICY = "ask";
  try {
    const store = createStore();
    const first = await store.create();
    const second = await store.create();
    const host = store.networkAccessHost();
    assert.equal(host.mode(), "ask");

    store.networkAccess.approve(first.id);
    assert.equal(host.allows(first.id), true);
    assert.equal(host.allows(second.id), false);
    assert.equal(host.allows("unknown"), false);
  } finally {
    if (previous === undefined) delete process.env.PI_SANDBOX_NETWORK_POLICY;
    else process.env.PI_SANDBOX_NETWORK_POLICY = previous;
  }
});

// 承認の key になるセッション id は、永続化なしの会話では作成後にしか決まらない (SDK が発行する)。
// 定義の生成時に固定すると undefined のままになり、ask / deny を迂回してしまう。
test("承認の sessionId は実行時に解決し、解決できなければ質問せずに断る", async () => {
  let id: string | undefined;
  const host = createHost({ mode: "ask" });
  const [tool] = createRequestNetworkAccessToolDefinitions({ enabled: true, sessionId: () => id, host });
  const unresolved = (await tool?.execute("call-1", { reason: "r" }, undefined, undefined, {} as never)) as {
    isError?: boolean;
    content: { text?: string }[];
  };
  assert.equal(unresolved.isError, true);
  assert.equal(host.calls, 0, "id が無いまま質問を出さない");

  id = "s1";
  await tool?.execute("call-1", { reason: "r" }, undefined, undefined, {} as never);
  assert.equal(host.calls, 1, "作成後の id で質問する");
});

// sweep は会話の削除ではないが、メモリから外した承認を残すと次のロードで効き続ける。
test("sweep と、sweep 済みの会話の削除でも承認を失効する", async () => {
  const store = createStore();
  const swept = await store.create();
  store.networkAccess.approve(swept.id);
  swept.lastUsedAt = Date.now() - 24 * 60 * 60 * 1000;
  await store.sweep();
  assert.equal(store.get(swept.id), undefined, "sweep でメモリから外れる");
  assert.equal(store.networkAccess.isApproved(swept.id), false, "sweep でも承認を残さない");

  // live な record が無い状態の削除でも失効する (descriptor だけが残っている経路)。
  // descriptor は永続化した会話にしか残らないため、storeDir を渡して同じ経路を通す
  const storeDir = await mkdtemp(join(tmpdir(), "pi-net-access-"));
  const persistent = createStore({ storeDir });
  const deleted = await persistent.create();
  deleted.lastUsedAt = Date.now() - 24 * 60 * 60 * 1000;
  await persistent.sweep();
  assert.equal(persistent.get(deleted.id), undefined, "sweep でメモリから外れる");
  persistent.networkAccess.approve(deleted.id);
  assert.equal(await persistent.deleteSession(deleted.id), true, "descriptor だけでも削除できる");
  assert.equal(persistent.networkAccess.isApproved(deleted.id), false);
});

// 承認の key は SDK のセッション id。永続化なしの通常会話で SDK が別 id を発行すると、承認要求が
// SessionStore の record に届かず、exec 側も別の key を読んで永久に未承認になる。
test("永続化なしでも SDK のセッション id は record.id と一致し、承認が exec に効く", async () => {
  const previous = process.env.PI_SANDBOX_NETWORK_POLICY;
  process.env.PI_SANDBOX_NETWORK_POLICY = "ask";
  try {
    const store = createStore();
    const record = await store.create();
    assert.equal(record.session.sessionId, record.id, "SDK の id を record と揃える");

    const host = store.networkAccessHost();
    assert.equal(host.allows(record.session.sessionId), false);
    // 承認要求は SDK の id で登録され、同じ id で回答できる
    const pending = host.ask(record.session.sessionId, "call-1", networkAccessQuestions("r"), undefined);
    assert.equal(store.answerQuestion(record, "call-1", [{ index: 0, approval: true }]).status, "ok");
    await pending;
    // 次の exec が読む key でも承認済みになる
    assert.equal(host.allows(record.session.sessionId), true);
  } finally {
    if (previous === undefined) delete process.env.PI_SANDBOX_NETWORK_POLICY;
    else process.env.PI_SANDBOX_NETWORK_POLICY = previous;
  }
});
