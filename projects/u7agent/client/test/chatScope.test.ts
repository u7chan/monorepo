// main 領域に出す「作業先」の解決。セッション未作成は作成先、セッションありは所属で決まり、
// 名前が引けないときは左バーの未所属と同じ規則で「未所属」へ寄せる (docs/ui-layout.md)。
import assert from "node:assert/strict";
import test from "node:test";
import { chatScope } from "../src/lib/chatScope";
import type { Project, SessionSummary } from "../src/types";

const PROJECTS: Project[] = [
  { id: "p1", name: "u7agent", cwd: "projects/u7agent", createdAt: 1 },
  { id: "p2", name: "hello", cwd: "work/hello", createdAt: 2 },
];

function session(sessionId: string, projectId?: string): SessionSummary {
  return {
    sessionId,
    title: "会話",
    agentId: "default",
    status: "idle",
    queueDepth: 0,
    messageCount: 1,
    createdAt: 1,
    lastUsedAt: 1,
    projectId,
  };
}

/** 未作成チャット (sessionId が空) の入力。指定した分だけ差し替える */
function newChat(input: {
  selectedProjectId?: string;
  cwd?: string;
  projects?: Project[];
  sessions?: SessionSummary[];
}) {
  return chatScope({
    cwd: input.cwd ?? "",
    sessionId: "",
    selectedProjectId: input.selectedProjectId ?? "",
    projects: input.projects ?? PROJECTS,
    sessions: input.sessions ?? [],
  });
}

test("未作成チャットは作成先プロジェクトを作業先にする", () => {
  assert.deepEqual(newChat({ selectedProjectId: "p2" }), {
    label: "hello",
    project: true,
    root: "work/hello",
  });
});

test("未作成チャットの未所属はキャッチコピーのまま (root も無い)", () => {
  assert.deepEqual(newChat({ selectedProjectId: "" }), { label: "未所属", project: false, root: "" });
});

test("セッションがあるときは作成先ではなく所属を見る", () => {
  const scope = chatScope({
    cwd: ".u7agent/sessions/01a0b4cf",
    sessionId: "s1",
    // 別のプロジェクトの新規会話 (プロジェクト行の ＋) を開いていても、表示中のセッションの所属が優先される
    selectedProjectId: "p1",
    projects: PROJECTS,
    sessions: [session("s1", "p2")],
  });
  assert.deepEqual(scope, { label: "hello", project: true, root: ".u7agent/sessions/01a0b4cf" });
});

test("プロジェクト名が引けないときは未所属 (解除後もフォルダは残る)", () => {
  const removed = chatScope({
    cwd: "work/hello",
    sessionId: "s1",
    selectedProjectId: "",
    projects: PROJECTS,
    // 登録が解除されて一覧から消えても、セッションの projectId は残り得る
    sessions: [session("s1", "p9")],
  });
  assert.deepEqual(removed, { label: "未所属", project: false, root: "work/hello" });

  const unassigned = chatScope({
    cwd: ".u7agent/sessions/01a0b4cf",
    sessionId: "s1",
    selectedProjectId: "",
    projects: PROJECTS,
    sessions: [session("s1")],
  });
  assert.deepEqual(unassigned, { label: "未所属", project: false, root: ".u7agent/sessions/01a0b4cf" });
});

test("一覧の取得前は未所属 (root も解決できるまで空)", () => {
  // 作成先の id は一覧の到着前に設定され得るが、名前は一覧の到着まで引けない
  assert.deepEqual(newChat({ selectedProjectId: "p2", projects: [] }), { label: "未所属", project: false, root: "" });
  // 表示中のセッションの所属も、一覧に無いうちは引けない (payload.cwd だけ先に届く)
  const scope = chatScope({
    cwd: "work/hello",
    sessionId: "s1",
    selectedProjectId: "",
    projects: [],
    sessions: [],
  });
  assert.deepEqual(scope, { label: "未所属", project: false, root: "work/hello" });
});
