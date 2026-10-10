// セッション一覧のプロジェクト別グループ化とピン留めの分離。DOM を使わず、並び順と未所属の分離だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { groupSessionsByProject, splitByPinned } from "../src/lib/sessionsByProject";
import type { Project, SessionSummary } from "../src/types";

const project = (id: string, cwd: string, createdAt: number): Project => ({
  id,
  name: id,
  cwd,
  createdAt,
});

const session = (sessionId: string, lastUsedAt: number, projectId?: string): SessionSummary => ({
  sessionId,
  title: sessionId,
  agentId: "agent",
  status: "idle",
  queueDepth: 0,
  messageCount: 0,
  createdAt: lastUsedAt,
  lastUsedAt,
  pinned: false,
  ...(projectId ? { projectId } : {}),
});

test("プロジェクトの並びは一覧どおりで、配下セッションは lastUsedAt の降順になる", () => {
  const projects = [project("p1", "work/a", 1), project("p2", "work/b", 2)];
  const sessions = [session("a-old", 100, "p1"), session("b-new", 300, "p2"), session("a-new", 200, "p1")];

  const { groups, unassigned } = groupSessionsByProject(sessions, projects);

  assert.deepEqual(
    groups.map((group) => [group.project.id, group.sessions.map((item) => item.sessionId)]),
    [
      ["p1", ["a-new", "a-old"]],
      ["p2", ["b-new"]],
    ],
  );
  assert.deepEqual(unassigned, []);
});

test("未所属セッションは分離し、こちらも lastUsedAt の降順になる", () => {
  const projects = [project("p1", "work/a", 1)];
  const sessions = [session("loose-old", 10), session("owned", 20, "p1"), session("loose-new", 30)];

  const { groups, unassigned } = groupSessionsByProject(sessions, projects);

  assert.deepEqual(
    groups[0]?.sessions.map((item) => item.sessionId),
    ["owned"],
  );
  assert.deepEqual(
    unassigned.map((item) => item.sessionId),
    ["loose-new", "loose-old"],
  );
});

test("未知の projectId は未所属へ寄せる (一覧から消さない)", () => {
  const { groups, unassigned } = groupSessionsByProject([session("orphan", 5, "gone")], [project("p1", "work/a", 1)]);

  assert.deepEqual(groups[0]?.sessions, []);
  assert.deepEqual(
    unassigned.map((item) => item.sessionId),
    ["orphan"],
  );
});

test("セッションが無いプロジェクトも空配列で返し、入力の並びは変えない", () => {
  const projects = [project("p1", "work/a", 1), project("p2", "work/b", 2)];
  const sessions = [session("old", 1, "p2"), session("new", 2, "p2")];

  const { groups } = groupSessionsByProject(sessions, projects);

  assert.deepEqual(
    groups.map((group) => group.sessions.length),
    [0, 2],
  );
  assert.deepEqual(
    sessions.map((item) => item.sessionId),
    ["old", "new"],
  );
});

test("プロジェクト内と未所属の両方でピン留めを先にし、同時刻の元順を保つ", () => {
  const projects = [project("p1", "work/a", 1)];
  const sessions = [
    session("project-unpinned-new", 300, "p1"),
    { ...session("project-pinned-old", 100, "p1"), pinned: true },
    { ...session("project-pinned-first", 300, "p1"), pinned: true },
    { ...session("project-pinned-tied", 300, "p1"), pinned: true },
    session("loose-unpinned-new", 300),
    { ...session("loose-pinned-old", 100), pinned: true },
    { ...session("loose-pinned-first", 300), pinned: true },
    { ...session("loose-pinned-tied", 300), pinned: true },
  ];

  const { groups, unassigned } = groupSessionsByProject(sessions, projects);
  assert.deepEqual(
    groups[0]?.sessions.map((item) => item.sessionId),
    ["project-pinned-first", "project-pinned-tied", "project-pinned-old", "project-unpinned-new"],
  );
  assert.deepEqual(
    unassigned.map((item) => item.sessionId),
    ["loose-pinned-first", "loose-pinned-tied", "loose-pinned-old", "loose-unpinned-new"],
  );
});

test("ピン留めの分離は入力の並びを変えず、pinned が true の行だけを先へ集める", () => {
  const sessions = [
    session("unpinned-new", 300),
    { ...session("pinned-old", 100), pinned: true },
    session("unpinned-old", 200),
    { ...session("pinned-new", 250), pinned: true },
  ];

  const { pinned, rest } = splitByPinned(sessions);

  assert.deepEqual(
    pinned.map((item) => item.sessionId),
    ["pinned-old", "pinned-new"],
  );
  assert.deepEqual(
    rest.map((item) => item.sessionId),
    ["unpinned-new", "unpinned-old"],
  );
});

test("ピン留めが無いときは全件がそのまま rest へ入る", () => {
  const sessions = [session("a", 2), session("b", 1)];

  const { pinned, rest } = splitByPinned(sessions);

  assert.deepEqual(pinned, []);
  assert.deepEqual(
    rest.map((item) => item.sessionId),
    ["a", "b"],
  );
});
