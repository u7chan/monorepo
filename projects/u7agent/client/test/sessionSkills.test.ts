// チャットのスキル一覧の取得先・状態の写し・表示用導出 (グループ分け / 注意書き / 場所の表示 / 挿入するコマンド)
// を DOM なしで固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequestGate } from "../src/hooks/requestGate";
import {
  SESSION_SKILL_EMPTY_NOTE,
  SESSION_SKILL_ERROR_PREFIX,
  SESSION_SKILL_LOADING_NOTE,
  SESSION_SKILL_RELOAD_ERROR_PREFIX,
  SESSION_SKILL_SHADOWED_NOTE,
  SESSION_SKILL_UNAVAILABLE_NOTE,
  fetchSessionSkills,
  groupSessionSkills,
  reduceSessionSkills,
  sessionSkillLocation,
  sessionSkillsNotice,
  sessionSkillsSource,
  sessionSkillsSourceKey,
  sessionSkillWarning,
  skillCommandText,
  skillLocationLabel,
  startSessionSkillsReload,
  type SessionSkillsFetchers,
  type SessionSkillsState,
} from "../src/lib/sessionSkills";
import type { SessionSkillInfo, SessionSkillsPreview, SessionSkillsResponse } from "../src/types";

const ROOT = "/workspace";

function sessionSkill(overrides: Partial<SessionSkillInfo> = {}): SessionSkillInfo {
  return {
    name: "alpha",
    description: "アルファの説明",
    scope: "user",
    location: `${ROOT}/.agents/skills/alpha/SKILL.md`,
    relativePath: ".agents/skills/alpha/SKILL.md",
    disableModelInvocation: false,
    shadowed: false,
    shadowedBy: null,
    shadows: [],
    ...overrides,
  };
}

test("groupSessionSkills は優先順位の順にまとめ、空のスコープを出さない", () => {
  const groups = groupSessionSkills([
    sessionSkill({ name: "common", scope: "user" }),
    sessionSkill({
      name: "catalog",
      scope: "catalog",
      location: `${ROOT}/.u7agent/agent-skills/catalog/SKILL.md`,
      relativePath: ".u7agent/agent-skills/catalog/SKILL.md",
    }),
    sessionSkill({ name: "proj", scope: "project" }),
    sessionSkill({ name: "builtin", scope: "builtin" }),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.scope, group.label, group.skills.map((skill) => skill.name)]),
    [
      ["project", "プロジェクト", ["proj"]],
      ["user", "共通", ["common"]],
      ["builtin", "組み込み", ["builtin"]],
      ["catalog", "エージェント定義", ["catalog"]],
    ],
  );
  assert.deepEqual(groupSessionSkills([]), []);
  assert.deepEqual(
    groupSessionSkills([sessionSkill({ scope: "builtin" })]).map((group) => group.scope),
    ["builtin"],
  );
});

test("skillCommandText は引数を続けて書けるよう末尾に空白を入れる", () => {
  assert.equal(skillCommandText("writer"), "/skill:writer ");
  assert.equal(skillCommandText("writer").trim(), "/skill:writer");
});

test("skillLocationLabel は root 配下を root 相対へ落とし、root の外の値はそのまま返す", () => {
  assert.equal(skillLocationLabel(ROOT, `${ROOT}/.agents/skills/a/SKILL.md`), ".agents/skills/a/SKILL.md");
  assert.equal(skillLocationLabel(`${ROOT}/`, `${ROOT}/x/SKILL.md`), "x/SKILL.md", "root の末尾スラッシュは無視する");
  assert.equal(skillLocationLabel(ROOT, "/elsewhere/x/SKILL.md"), "/elsewhere/x/SKILL.md", "root の外は絶対パスのまま");
  // 仮想パス (組み込み / カタログ) も root 配下なので root 相対になる
  assert.equal(
    skillLocationLabel(ROOT, `${ROOT}/.u7agent/agent-skills/alpha/SKILL.md`),
    ".u7agent/agent-skills/alpha/SKILL.md",
  );
  assert.equal(skillLocationLabel("", `${ROOT}/x/SKILL.md`), `${ROOT}/x/SKILL.md`, "root 未取得でも壊れない");
});

test("sessionSkillWarning は使われない行と、隠している行をそれぞれ説明する", () => {
  // 同名の上位スコープがある行 (組み込み / カタログ)
  assert.equal(
    sessionSkillWarning(
      sessionSkill({ scope: "builtin", shadowed: true, shadowedBy: `${ROOT}/.agents/skills/alpha/SKILL.md` }),
      ROOT,
    ),
    `${SESSION_SKILL_SHADOWED_NOTE}: .agents/skills/alpha/SKILL.md`,
  );
  // 優先される側 (採用された行) は隠した側を示す
  assert.equal(
    sessionSkillWarning(sessionSkill({ shadows: [`${ROOT}/.agents/skills/alpha/SKILL.md`] }), ROOT),
    "同名のスキルは読み込まれません: .agents/skills/alpha/SKILL.md",
  );
  assert.equal(sessionSkillWarning(sessionSkill(), ROOT), null);
  // shadowedBy が無い (スナップショット由来の情報が欠けた) 場合も文言は出す
  assert.equal(sessionSkillWarning(sessionSkill({ shadowed: true }), ROOT), SESSION_SKILL_SHADOWED_NOTE);
});

test("sessionSkillLocation はカタログを仮想パスで示す", () => {
  assert.equal(sessionSkillLocation(sessionSkill(), ROOT), ".agents/skills/alpha/SKILL.md");
  assert.equal(
    sessionSkillLocation(
      sessionSkill({
        scope: "catalog",
        location: `${ROOT}/.u7agent/agent-skills/alpha/SKILL.md`,
        relativePath: ".u7agent/agent-skills/alpha/SKILL.md",
      }),
      ROOT,
    ),
    ".u7agent/agent-skills/alpha/SKILL.md",
  );
});

test("sessionSkillsSource はセッションを優先し、新規チャットでは作成前の選択を使う", () => {
  assert.deepEqual(sessionSkillsSource("s1", "p1", "a1"), { kind: "session", sessionId: "s1" });
  assert.deepEqual(sessionSkillsSource("", "p1", "a1"), { kind: "preview", projectId: "p1", agentId: "a1" });
  // 未所属 / エージェント未選択もそのまま渡す (初期値の解決はサーバーが行う)
  assert.deepEqual(sessionSkillsSource("", "", ""), { kind: "preview", projectId: "", agentId: "" });
});

test("sessionSkillsSourceKey は取得先が変わるときだけ変わる", () => {
  const key = (sessionId: string, projectId: string, agentId: string) =>
    sessionSkillsSourceKey(sessionSkillsSource(sessionId, projectId, agentId));
  assert.equal(key("s1", "p1", "a1"), "session:s1");
  assert.equal(key("", "p1", "a1"), "preview:p1:a1");
  // セッションがある間のプロジェクト / エージェントの切替では取り直さない (取得先がセッションに固定される)
  assert.equal(key("s1", "p1", "a1"), key("s1", "p2", "a2"));
  // 新規チャットはプロジェクト / エージェントの切替で取り直す
  assert.notEqual(key("", "p1", "a1"), key("", "p2", "a1"));
  assert.notEqual(key("", "p1", "a1"), key("", "p1", "a2"));
  // セッションの確定 (新規チャット → 送信後) でセッション基準へ切り替える
  assert.notEqual(key("", "p1", "a1"), key("s1", "p1", "a1"));
});

/**
 * `fetchSessionSkills` が受ける functional な setState を、適用後の状態の列として集める。
 * 実際の `useState` と同じく、前の状態を引き継いで畳む (再取得の「一覧を残す」判断が効く)。
 */
function collector(initial: SessionSkillsState): {
  apply: (update: (previous: SessionSkillsState) => SessionSkillsState) => void;
  states: SessionSkillsState[];
} {
  let current = initial;
  const states: SessionSkillsState[] = [];
  return {
    apply: (update) => {
      current = update(current);
      states.push(current);
    },
    states,
  };
}

test("fetchSessionSkills は取得先に応じて API を呼び、応答を ready へ写す", async () => {
  const calls: string[] = [];
  const fetchers: SessionSkillsFetchers = {
    session: async (sessionId: string): Promise<SessionSkillsResponse> => {
      calls.push(`session:${sessionId}`);
      return { sessionId, cwd: "proj", projectSkills: true, skills: [sessionSkill({ name: "from-session" })] };
    },
    preview: async (input: { projectId: string; agentId: string }): Promise<SessionSkillsPreview> => {
      calls.push(`preview:${input.projectId}:${input.agentId}`);
      return { cwd: "proj", projectSkills: true, skills: [sessionSkill({ name: "from-preview" })] };
    },
  };
  const applied = collector({ status: "loading" });

  await fetchSessionSkills({ kind: "session", sessionId: "s1" }, fetchers, () => true, applied.apply);
  await fetchSessionSkills({ kind: "preview", projectId: "p1", agentId: "" }, fetchers, () => true, applied.apply);

  assert.deepEqual(calls, ["session:s1", "preview:p1:"], "セッションがあれば既存 API だけを使う");
  assert.deepEqual(
    applied.states.map((state) =>
      state.status === "ready" ? [state.skills[0]?.name, state.projectSkills] : state.status,
    ),
    [
      ["from-session", true],
      ["from-preview", true],
    ],
  );
});

test("fetchSessionSkills は失敗を error にし、切替後に届いた古い応答は捨てる", async () => {
  // 503 (サンドボックス未設定) はポップアップへ理由を出す。ボタンは押せるままにする (unavailable にしない)
  const failure = Object.assign(new Error("サンドボックスが設定されていません (PI_SANDBOX_URL / PI_SANDBOX_TOKEN)"), {
    status: 503,
  });
  const failed = collector({ status: "loading" });
  await fetchSessionSkills(
    { kind: "preview", projectId: "", agentId: "" },
    {
      session: async () => {
        throw new Error("使わない");
      },
      preview: async () => {
        throw failure;
      },
    },
    () => true,
    failed.apply,
  );
  assert.deepEqual(failed.states, [{ status: "error", message: failure.message }]);
  assert.deepEqual(sessionSkillsNotice(failed.states[0] as SessionSkillsState), {
    text: `${SESSION_SKILL_ERROR_PREFIX}: ${failure.message}`,
    warn: true,
    retry: true,
  });

  // プレビュー取得中に取得先が変わる: 後から開始した方の応答だけを反映する
  const beginRequest = createRequestGate();
  let releaseOld!: () => void;
  const oldResponse = new Promise<SessionSkillsPreview>((resolve) => {
    releaseOld = () => resolve({ cwd: "", projectSkills: false, skills: [sessionSkill({ name: "old" })] });
  });
  const fetchers: SessionSkillsFetchers = {
    session: async () => {
      throw new Error("使わない");
    },
    preview: async ({ projectId }: { projectId: string }) =>
      projectId === "p1" ? oldResponse : { cwd: "", projectSkills: false, skills: [sessionSkill({ name: "new" })] },
  };
  const switched = collector({ status: "loading" });
  const oldRequest = fetchSessionSkills(
    { kind: "preview", projectId: "p1", agentId: "" },
    fetchers,
    beginRequest(),
    switched.apply,
  );
  const latest = fetchSessionSkills(
    { kind: "preview", projectId: "p2", agentId: "" },
    fetchers,
    beginRequest(),
    switched.apply,
  );
  await latest;
  releaseOld();
  await oldRequest;
  assert.deepEqual(
    switched.states.map((state) => (state.status === "ready" ? state.skills[0]?.name : state.status)),
    ["new"],
    "切替後に届いた古い一覧は反映しない",
  );
});

test("reduceSessionSkills は一覧を持っている間の失敗で一覧を捨てない", () => {
  const list: SessionSkillsState = { status: "ready", skills: [sessionSkill()], projectSkills: true };
  // 再取得の失敗は reloadError として重ね、索引として使える一覧は残す
  assert.deepEqual(reduceSessionSkills(list, { ok: false, message: "503" }), { ...list, reloadError: "503" });
  // 一覧が無いときの失敗は error (理由を出すしかない)
  assert.deepEqual(reduceSessionSkills({ status: "loading" }, { ok: false, message: "503" }), {
    status: "error",
    message: "503",
  });
  // 再取得の成功は前の reloadError を消す (状態を ready で作り直す)
  assert.deepEqual(
    reduceSessionSkills({ ...list, reloadError: "503" }, { ok: true, skills: [], projectSkills: false }),
    { status: "ready", skills: [], projectSkills: false },
  );
  assert.deepEqual(
    reduceSessionSkills({ status: "error", message: "503" }, { ok: true, skills: [], projectSkills: false }),
    {
      status: "ready",
      skills: [],
      projectSkills: false,
    },
  );
});

test("startSessionSkillsReload は持っている一覧を消さず、無いときだけ読込表示へ戻す", () => {
  const list: SessionSkillsState = { status: "ready", skills: [sessionSkill()], projectSkills: false };
  assert.deepEqual(startSessionSkillsReload(list), list, "開き直しで一覧を消さない (高さを跳ねさせない)");
  assert.deepEqual(startSessionSkillsReload({ ...list, reloadError: "503" }), { ...list, reloadError: "503" });
  assert.deepEqual(startSessionSkillsReload({ status: "error", message: "503" }), { status: "loading" });
  assert.deepEqual(startSessionSkillsReload({ status: "unavailable" }), { status: "loading" });
});

test("sessionSkillsNotice は状態ごとの 1 行と再取得の要否を返す", () => {
  assert.deepEqual(sessionSkillsNotice({ status: "loading" }), {
    text: SESSION_SKILL_LOADING_NOTE,
    warn: false,
    retry: false,
  });
  // 取得先が判明していない間は理由を出し、ボタンは押せない (Composer の enabled が unavailable だけを弾く)
  assert.deepEqual(sessionSkillsNotice({ status: "unavailable" }), {
    text: SESSION_SKILL_UNAVAILABLE_NOTE,
    warn: false,
    retry: false,
  });
  assert.deepEqual(sessionSkillsNotice({ status: "error", message: "503" }), {
    text: `${SESSION_SKILL_ERROR_PREFIX}: 503`,
    warn: true,
    retry: true,
  });
  assert.deepEqual(sessionSkillsNotice({ status: "ready", skills: [], projectSkills: false }), {
    text: SESSION_SKILL_EMPTY_NOTE,
    warn: false,
    retry: true,
  });
  assert.equal(sessionSkillsNotice({ status: "ready", skills: [sessionSkill()], projectSkills: true }), null);
  // 一覧を持ったままの再取得失敗は、0 件の注意ではなく理由を見せる
  assert.deepEqual(
    sessionSkillsNotice({ status: "ready", skills: [sessionSkill()], projectSkills: true, reloadError: "503" }),
    { text: `${SESSION_SKILL_RELOAD_ERROR_PREFIX}: 503`, warn: true, retry: true },
  );
  assert.deepEqual(sessionSkillsNotice({ status: "ready", skills: [], projectSkills: false, reloadError: "503" }), {
    text: `${SESSION_SKILL_RELOAD_ERROR_PREFIX}: 503`,
    warn: true,
    retry: true,
  });
});
