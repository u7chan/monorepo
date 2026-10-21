// 作業環境 → 環境変数タブの表示 / 入力の純関数。名前の見せ方と文言だけを固定する (値の表示判定は envValue.test.ts)。
import assert from "node:assert/strict";
import test from "node:test";
import {
  canSubmitEnvDraft,
  canSubmitEnvValue,
  ENV_KIND_LEGEND,
  ENV_PROJECT_NOTE,
  ENV_SAVE_LABEL,
  ENV_SECRET_NOTES,
  ENV_SHORT_SECRET_NOTE,
  ENV_TRIM_NOTE,
  ENV_VARIABLE_NOTES,
  envKindLabel,
  envKindNotes,
  envNameList,
  envNamePreview,
  envValueActionLabel,
  envValueFormTitle,
  initialDraftValue,
  orderedEnvItems,
  SECRET_MASK_MIN_LENGTH,
  sessionEnvScope,
  sessionEnvScopeFromKey,
  sessionEnvScopeKey,
  secretDeleteConfirmRequest,
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
  // 注入先はアプリではなく serve の起動経路として書き、変数とシークレットの違いを「だけ」で読み違えさせない
  assert.ok(ENV_SECRET_NOTES.includes("サービスとして起動したときに参照できます"));
  assert.ok(ENV_VARIABLE_NOTES.includes("サービスの起動プロセスにも入ります"));
  assert.ok(!ENV_SECRET_NOTES.some((note) => note.includes("だけ")));
  assert.ok(!ENV_VARIABLE_NOTES.some((note) => note.includes("だけ")));
  assert.equal(ENV_PROJECT_NOTE, "このプロジェクトの設定です");
  assert.equal(ENV_TRIM_NOTE, "前後に空白 / 改行があったため除去しました");
});

test("凡例は種別ごとに反映の境界と注入先を 1 行で示し、一覧の上を長文で埋めない", () => {
  assert.deepEqual(
    ENV_KIND_LEGEND.map((entry) => entry.kind),
    ["variable", "secret"],
  );
  const [variable, secret] = ENV_KIND_LEGEND;
  assert.ok(variable.text.startsWith("次の bash から反映"), variable.text);
  assert.ok(variable.text.includes("bash"), variable.text);
  assert.ok(variable.text.includes("サービス起動時"), variable.text);
  assert.ok(secret.text.startsWith("次回の起動から反映"), secret.text);
  // シークレットの注入先はサービスの起動時だけ (変数の行に書いた bash との差で読ませる)
  assert.ok(secret.text.includes("サービス起動時"), secret.text);
  assert.ok(secret.text.includes("だけ"), secret.text);
  // 長い説明へ戻さない (ラベルのために一覧が下がるのを防ぐ)
  for (const entry of ENV_KIND_LEGEND) assert.ok(entry.text.length <= 40, entry.text);
});

test("短い値の注記はシークレットの入力中だけ出す", () => {
  assert.equal(SECRET_MASK_MIN_LENGTH, 8);
  assert.equal(shortSecretNote("secret", "1234567"), ENV_SHORT_SECRET_NOTE);
  assert.equal(shortSecretNote("secret", "12345678"), undefined);
  assert.equal(shortSecretNote("secret", ""), undefined, "空欄では出さない");
  assert.equal(shortSecretNote("variable", "x"), undefined, "変数には出さない");
});

test("行メニューとフォーム見出しは種別で編集 / 変更を使い分け、主ボタンは共通で「保存」", () => {
  assert.equal(envValueActionLabel("variable"), "値を編集");
  assert.equal(envValueActionLabel("secret"), "値を変更");
  assert.equal(envValueFormTitle(item({ kind: "variable", name: "DATABASE_URL" })), "DATABASE_URL の値を編集");
  assert.equal(envValueFormTitle(item({ kind: "secret", name: "OPENAI_API_KEY" })), "OPENAI_API_KEY の値を変更");
  // 同じフォームに編集・変更・保存の 3 語を並べない (主ボタンは種別で変えない)
  assert.equal(ENV_SAVE_LABEL, "保存");
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

test("並べ替えの下書きは行を落とさず、下書きに無い行を一覧の順のまま末尾へ回す", () => {
  const rows = [
    item({ secretId: "s1", name: "A" }),
    item({ secretId: "s2", name: "B" }),
    item({ secretId: "s3", name: "C" }),
  ];
  assert.deepEqual(
    orderedEnvItems(rows, null).map((row) => row.secretId),
    ["s1", "s2", "s3"],
    "下書きが無ければ一覧の順",
  );
  assert.deepEqual(
    orderedEnvItems(rows, ["s3", "s1", "s2"]).map((row) => row.secretId),
    ["s3", "s1", "s2"],
  );
  // ドラッグ中に別タブが追加した行は、下書きに無くても消さずに末尾へ回す
  const withNewRow = [...rows, item({ secretId: "s4", name: "D" })];
  assert.deepEqual(
    orderedEnvItems(withNewRow, ["s3", "s1"]).map((row) => row.secretId),
    ["s3", "s1", "s2", "s4"],
  );
  // 未知の id は無視し、元の配列は書き換えない
  assert.deepEqual(
    orderedEnvItems(rows, ["s3", "nope", "s1", "s2"]).map((row) => row.secretId),
    ["s3", "s1", "s2"],
  );
  assert.deepEqual(
    rows.map((row) => row.secretId),
    ["s1", "s2", "s3"],
  );
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

test("削除の確認は対象の名前を独立した行へ出し、シークレットは値が戻せないことを先に伝える", () => {
  const secret = secretDeleteConfirmRequest(item({ kind: "secret", name: "OPENAI_API_KEY" }));
  assert.equal(secret.title, "シークレットを削除");
  assert.deepEqual(secret.subject, { label: "削除するシークレット", value: "OPENAI_API_KEY" });
  assert.deepEqual(secret.body, ["保存した値は再取得できません。"]);
  assert.equal(secret.confirmLabel, "削除する");
  assert.ok(secret.danger, "削除は danger にする");

  // 変数は値を読み直せるので、シークレットの注意は出さない
  const variable = secretDeleteConfirmRequest(item({ kind: "variable", name: "LOG_LEVEL" }));
  assert.equal(variable.title, "環境変数を削除");
  assert.deepEqual(variable.subject, { label: "削除する変数", value: "LOG_LEVEL" });
  assert.equal(variable.body, undefined);
});
