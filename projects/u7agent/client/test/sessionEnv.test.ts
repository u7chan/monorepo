// 作業環境 → 環境変数タブの表示 / 入力の純関数。値そのものは扱わず、名前の見せ方と文言だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  canSubmitEnvDraft,
  canSubmitEnvValue,
  ENV_PROJECT_NOTE,
  ENV_RESTART_NOTE,
  ENV_SECRET_NOTES,
  ENV_SHORT_SECRET_NOTE,
  ENV_TRIM_NOTE,
  ENV_VARIABLE_NOTES,
  envKindLabel,
  envKindNotes,
  envNameList,
  envNamePreview,
  initialDraftValue,
  SECRET_MASK_MIN_LENGTH,
  sessionEnvScope,
  sessionEnvScopeFromKey,
  sessionEnvScopeKey,
  sessionEnvTabs,
  SESSION_ENV_TABS,
  shortSecretNote,
} from "../src/lib/sessionEnv";
import type { SecretItem } from "../src/types";

const item = (overrides: Partial<SecretItem> = {}): SecretItem => ({
  secretId: "s1",
  name: "API_KEY",
  kind: "secret",
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

test("名前のプレビューは保存・注入・表示と同じ正規化 (trim + 大文字化) を出す", () => {
  assert.equal(envNamePreview("  database_url "), "DATABASE_URL");
  assert.equal(envNamePreview(""), "");
  assert.equal(envNamePreview("   "), "");
});

test("種別のラベルと説明は値の見え方を先に示す", () => {
  assert.equal(envKindLabel("secret"), "シークレット");
  assert.equal(envKindLabel("variable"), "変数");
  assert.deepEqual(envKindNotes("secret"), ENV_SECRET_NOTES);
  assert.ok(ENV_SECRET_NOTES.includes("シークレットはこの会話上では参照できません"));
  assert.ok(ENV_SECRET_NOTES.includes("保存後に値を再取得できません"));
  assert.ok(ENV_VARIABLE_NOTES.some((note) => note.includes("printenv")));
  // 注入先はアプリではなく serve の起動経路として書く
  assert.ok(ENV_SECRET_NOTES.includes("サービスとして起動したときだけ参照できます"));
  assert.equal(ENV_RESTART_NOTE, "シークレットの変更は次回の起動から反映されます");
  assert.equal(ENV_PROJECT_NOTE, "このプロジェクトの設定です");
  assert.equal(ENV_TRIM_NOTE, "前後に空白 / 改行があったため除去しました");
});

test("短い値の注記はシークレットの入力中だけ出す", () => {
  assert.equal(SECRET_MASK_MIN_LENGTH, 8);
  assert.equal(shortSecretNote("secret", "1234567"), ENV_SHORT_SECRET_NOTE);
  assert.equal(shortSecretNote("secret", "12345678"), undefined);
  assert.equal(shortSecretNote("secret", ""), undefined, "空欄では出さない");
  assert.equal(shortSecretNote("variable", "x"), undefined, "変数には出さない");
});

test("追加フォームは名前と値のどちらも空でないときだけ送れる", () => {
  assert.equal(canSubmitEnvDraft({ name: "API_KEY", value: "v" }), true);
  assert.equal(canSubmitEnvDraft({ name: " api_key ", value: " v " }), true);
  assert.equal(canSubmitEnvDraft({ name: "", value: "v" }), false);
  assert.equal(canSubmitEnvDraft({ name: "   ", value: "v" }), false);
  assert.equal(canSubmitEnvDraft({ name: "API_KEY", value: "" }), false);
  assert.equal(canSubmitEnvDraft({ name: "API_KEY", value: "   " }), false);
});

test("変更フォームの送信可否は値だけで決まる (名前と種別は変えられない)", () => {
  // 編集時は name の state が空のままなので、追加用の判定を使うと常に送れなくなる
  assert.equal(canSubmitEnvValue("dummy-value-1234"), true);
  assert.equal(canSubmitEnvValue(" v "), true);
  assert.equal(canSubmitEnvValue(""), false);
  assert.equal(canSubmitEnvValue("   "), false);
  assert.equal(canSubmitEnvDraft({ name: "", value: "v" }), false, "追加は名前が要る");
});

test("要求元の識別子は cwd が同じでも会話ごとに別の値になる (切替でドラフトを破棄する根拠)", () => {
  const a = sessionEnvScopeKey({ sessionId: "s1" });
  const b = sessionEnvScopeKey({ sessionId: "s2" });
  assert.notEqual(a, b);
  assert.notEqual(a, sessionEnvScopeKey({ projectId: "p1" }));
  assert.equal(sessionEnvScopeKey({}), "");
  assert.equal(sessionEnvScopeKey({ sessionId: "s1" }), "session:s1");
  assert.equal(sessionEnvScopeKey({ projectId: "p1" }), "project:p1");
});

test("識別子は要求元へ戻せる (取得の依存を値の比較だけで済ませる)", () => {
  // 一覧の取得は識別子から要求元を組み直すため、戻せないと別の id を送ってしまう
  for (const scope of [{ sessionId: "s1" }, { projectId: "p1" }, {}]) {
    assert.deepEqual(sessionEnvScopeFromKey(sessionEnvScopeKey(scope)), scope);
  }
});

test("変更フォームの初期値は変数だけプリフィルし、シークレットは空欄にする", () => {
  const values = { s1: "production" };
  assert.equal(initialDraftValue(item({ kind: "variable" }), values), "production");
  assert.equal(initialDraftValue(item({ kind: "secret" }), values), "");
  assert.equal(initialDraftValue(item({ kind: "variable", secretId: "missing" }), values), "");
});

test("エージェントへ渡す名前の一覧は一覧の並びをそのまま使う", () => {
  assert.deepEqual(envNameList([item({ name: "B" }), item({ name: "A", kind: "variable" })]), ["B", "A"]);
  assert.deepEqual(envNameList([]), []);
});

test("タブは cwd が決まっている会話で 2 つ出て、片方しか無い面ではタブバーごと出さない", () => {
  assert.deepEqual(
    SESSION_ENV_TABS.map((tab) => tab.label),
    ["作業フォルダ", "環境変数"],
  );
  const both = sessionEnvTabs({ root: "projects/alpha", scope: { projectId: "p1" } });
  assert.deepEqual(
    both.map((tab) => tab.id),
    ["files", "env"],
    "プロジェクト起点の新規会話では 2 つ出す (所有者が cwd のため保存できる)",
  );
  assert.deepEqual(
    sessionEnvTabs({ root: ".u7agent/sessions/s1", scope: { sessionId: "s1" } }).map((tab) => tab.id),
    ["files", "env"],
  );
  // 未所属の新規会話は root も要求元も無いので、どちらのタブも出さない (パネル自体を出さない)
  assert.deepEqual(sessionEnvTabs({ root: "", scope: null }), []);
  assert.deepEqual(
    sessionEnvTabs({ root: "", scope: { sessionId: "s1" } }).map((tab) => tab.id),
    ["env"],
  );
  assert.deepEqual(
    sessionEnvTabs({ root: "projects/alpha", scope: null }).map((tab) => tab.id),
    ["files"],
  );
});

test("要求元は会話があれば sessionId、未作成なら作成先プロジェクトの projectId になる", () => {
  assert.deepEqual(sessionEnvScope({ sessionId: "s1", projectId: "p1" }), { sessionId: "s1" });
  assert.deepEqual(sessionEnvScope({ sessionId: "", projectId: "p1" }), { projectId: "p1" });
  // 未所属の新規会話は cwd が決まらないため出さない (タブの対象外)
  assert.equal(sessionEnvScope({ sessionId: "", projectId: "" }), null);
});
