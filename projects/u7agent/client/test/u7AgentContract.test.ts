// useU7Agent の互換 export と返却 contract の固定。
//
// useU7Agent は画面 (App) から見た facade で、composer / 設定ページが型と定数を import している。
// 返却値は UI が使う名前を消さないことを型で、export は実行時で確認する。
import assert from "node:assert/strict";
import test from "node:test";
import type { U7Agent } from "../src/hooks/useU7Agent";

type ContractKeys = {
  chat: unknown;
  dispatch: unknown;
  health: unknown;
  catalog: unknown;
  agents: unknown;
  sessions: unknown;
  projects: unknown;
  selectedProject: unknown;
  selectedProjectId: unknown;
  sessionId: unknown;
  agentId: unknown;
  setAgentId: unknown;
  runtimeStatus: unknown;
  cwd: unknown;
  sending: unknown;
  settingsChanging: unknown;
  preselection: unknown;
  composerSettings: unknown;
  selectedAgent: unknown;
  stopVisible: unknown;
  attachments: unknown;
  loadCatalog: unknown;
  refreshSessions: unknown;
  refreshProjects: unknown;
  selectSession: unknown;
  selectProject: unknown;
  newChat: unknown;
  sendMessage: unknown;
  attachFiles: unknown;
  removeAttachment: unknown;
  stopAgent: unknown;
  deleteSession: unknown;
  createProject: unknown;
  deleteProject: unknown;
  changeModel: unknown;
  changeThinkingLevel: unknown;
};

// 返却 contract は「減っていないこと」だけを固定する (増やすのは自由)
type MissingKeys = Exclude<keyof ContractKeys, keyof U7Agent>;
const missingKeys: MissingKeys extends never ? true : MissingKeys = true;
void missingKeys;

// api.ts はモジュール読み込み時に location.origin を読む (ブラウザ前提)。node でも import できるよう最小の shim を置く
globalThis.location ??= { origin: "http://localhost" } as Location;
const { ALL_THINKING_LEVELS, effortLabel, useU7Agent } = await import("../src/hooks/useU7Agent");

test("keeps the facade exports used by the UI", () => {
  assert.equal(typeof useU7Agent, "function");
  assert.equal(effortLabel("xhigh"), "xHigh");
  assert.equal(effortLabel("unknown"), "unknown");
  assert.deepEqual(ALL_THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});
