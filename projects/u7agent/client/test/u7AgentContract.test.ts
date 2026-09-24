// useU7Agent の互換 export と返却 contract の固定。
//
// useU7Agent は画面 (App) から見た facade で、composer / 設定ページが型と定数を import している。
// 返却値は UI が使う名前を消さないことを型で、export は実行時で確認する。
// 起動処理の待機順は DOM で再現できないため、ソース走査で固定する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { U7Agent } from "../src/hooks/useU7Agent";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

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
  notifications: unknown;
  notify: unknown;
  toggleNotify: unknown;
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

/** 行コメントを除いてから走査する (説明文の中の `await` で誤判定しない) */
function withoutLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at >= 0 ? line.slice(0, at) : line;
    })
    .join("\n");
}

/** 起動処理 (boot) の本体。次の useEffect までを切り出す */
function bootSource(source: string): string {
  const start = source.indexOf("const boot = useEffectEvent(");
  const end = source.indexOf("useEffect(", start);
  assert.ok(start >= 0 && end > start, "boot の定義が見つからない");
  return source.slice(start, end);
}

test("起動処理は、保留の入口の基準にする選択世代を最初の await より前に読む", () => {
  const source = read("src/hooks/useU7Agent.ts");
  const boot = withoutLineComments(bootSource(source));
  const capture = boot.indexOf("pendingEntryRef.current = pendingSessionId");
  const firstAwait = boot.indexOf("await ");
  assert.ok(capture >= 0, "保留の入口の capture が無い");
  assert.ok(firstAwait >= 0, "boot に await が無い");
  // health / catalog / projects の待ちの間の選択も「後からの選択」に含める (await の後ろに置くと奪う)
  assert.ok(capture < firstAwait, "基準の選択世代を最初の await の後に読んでいる");
  // 世代は capture した値をそのまま使う (読み直すと、遅れて届いた応答が後からの選択を奪う)
  assert.equal(
    boot.slice(capture).split("selectionSeqRef.current").length - 1,
    1,
    "boot 内で基準の世代を読み直している",
  );
  assert.ok(boot.slice(capture, firstAwait).includes("selectionSeqRef.current"), "capture が世代を読んでいない");
  // ポーリングからの再解決も pendingEntryRef に保持した世代を使う
  const resolve = withoutLineComments(
    source.slice(source.indexOf("const resolvePendingEntry"), source.indexOf("const boot = useEffectEvent(")),
  );
  assert.ok(resolve.includes("const resolvePendingEntry"), "再解決の実装が見つからない");
  assert.ok(!resolve.includes("selectionSeqRef.current"), "再解決で世代を読み直している");
});

test("起動時は保留のリンクだけを開き、失敗時に別の会話へフォールバックしない", () => {
  const sessions = read("src/hooks/useSessions.ts");
  assert.doesNotMatch(sessions, /u7agent-session|localStorage/, "選択中の会話を保存・復元している");
  assert.match(sessions, /const \[sessionId, setSessionId\] = useState\(""\)/, "初期選択が空ではない");
  assert.ok(
    sessions.includes("selectSession(requested.sessionId, isCurrent, { fallbackOnFailure: false })"),
    "リンク先の取得に失敗したときのフォールバック禁止が無い",
  );
  assert.match(
    sessions,
    /if \(!fallbackOnFailure\) \{\s*newChatRef\.current\(\);\s*return "fallback";\s*\}\s*const next = nextAfterFailure/,
    "リンク先の取得失敗後に一覧走査を始めている",
  );
  assert.match(
    sessions,
    /if \(!pending\) return;\s*const requested = list\.find/,
    "保留 URL が無い起動で一覧から会話を選んでいる",
  );

  const boot = withoutLineComments(bootSource(read("src/hooks/useU7Agent.ts")));
  assert.ok(!boot.includes("restoreSession("), "保留 URL が無い boot から会話を復元している");
});
