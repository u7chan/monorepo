// バックアップファイルの封筒と対象の解釈。DOM を使わない純関数だけを固定する (方針は docs/ui-layout.md)。
import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKUP_SCHEMA,
  backupTargetIdsIn,
  describeBackupPayload,
  parseBackupFile,
  parseDefinitionsPayload,
  serializeBackup,
  splitImportTargets,
} from "../src/lib/backupFile";
import { BACKUP_TARGETS, backupTargetLabel, orderBackupTargets } from "../src/lib/backupTargets";

const EXPORTED_AT = new Date("2026-02-01T12:34:56.789Z");

function definitionsPayload(agents: unknown[], skills: unknown[]) {
  return { agents, skills };
}

test("複数対象の書き出しは 1 ファイルにまとめ、日付入りの名前を付ける", () => {
  const data = { definitions: definitionsPayload([{ id: "a" }], []), projects: [{ cwd: "demo" }] };
  const { fileName, text } = serializeBackup(["definitions", "projects"], data, EXPORTED_AT);

  assert.equal(fileName, "u7agent-backup-2026-02-01.json");
  assert.deepEqual(JSON.parse(text), {
    app: "u7agent",
    schema: BACKUP_SCHEMA,
    exportedAt: EXPORTED_AT.toISOString(),
    data,
  });
});

test("単一対象の書き出しは対象名をファイル名に使う", () => {
  const { fileName } = serializeBackup(["definitions"], { definitions: definitionsPayload([], []) }, EXPORTED_AT);
  assert.equal(fileName, "u7agent-definitions-2026-02-01.json");
});

test("書き出したファイルはそのまま読み戻せる", () => {
  const data = { definitions: definitionsPayload([{ id: "a" }], [{ id: "s" }]) };
  const { text } = serializeBackup(["definitions"], data, EXPORTED_AT);
  const parsed = parseBackupFile(text);

  assert.equal(parsed.app, "u7agent");
  assert.equal(parsed.schema, BACKUP_SCHEMA);
  assert.equal(parsed.exportedAt, EXPORTED_AT.toISOString());
  // 取り込み範囲は data のキーそのもの (対象を列挙した配列は持たない)
  assert.deepEqual(backupTargetIdsIn(parsed.data), ["definitions"]);
});

test("data のキーの並びに関わらず、対象は定義順に返る", () => {
  const parsed = parseBackupFile(
    JSON.stringify({ app: "u7agent", schema: 1, data: { projects: [], definitions: definitionsPayload([], []) } }),
  );
  assert.deepEqual(backupTargetIdsIn(parsed.data), ["definitions", "projects"]);
});

test("対象の選択順はファイルの中身に影響しない", () => {
  assert.deepEqual(orderBackupTargets(["appearance", "definitions"]), ["definitions", "appearance"]);
});

test("読み込めないファイルは原因の分かるメッセージで失敗する", () => {
  const cases: [string, string][] = [
    ["壊れた JSON", "{"],
    ["別アプリの JSON", JSON.stringify({ app: "other", schema: 1, data: {} })],
    ["旧形式 (封筒なし)", JSON.stringify({ agents: [], skills: [] })],
    ["schema 違い", JSON.stringify({ app: "u7agent", schema: 2, data: { definitions: {} } })],
    ["data なし", JSON.stringify({ app: "u7agent", schema: 1 })],
    ["data が空", JSON.stringify({ app: "u7agent", schema: 1, data: {} })],
    ["未知の対象", JSON.stringify({ app: "u7agent", schema: 1, data: { unknown: [] } })],
  ];
  for (const [label, text] of cases) {
    assert.throws(() => parseBackupFile(text), Error, label);
  }
});

test("準備中の対象を含むファイルは取り込まず、対象名を返す", () => {
  const split = splitImportTargets(["definitions", "projects", "appearance"]);

  assert.deepEqual(split.ready, ["definitions"]);
  assert.deepEqual(split.blocked, ["projects", "appearance"]);
});

test("対象を増やすと準備中の一覧から外れる", () => {
  // ready の定義はここが正。取り込みを実装したら ready を true にして、この期待値を更新する
  assert.deepEqual(
    BACKUP_TARGETS.map((target) => [target.id, target.ready]),
    [
      ["definitions", true],
      ["projects", false],
      ["sessions", false],
      ["appearance", false],
    ],
  );
  assert.equal(backupTargetLabel("sessions"), "会話履歴");
});

test("エージェントとスキルの形は適用前に検証する", () => {
  assert.deepEqual(parseDefinitionsPayload({ agents: [], skills: [] }), { agents: [], skills: [] });
  assert.throws(() => parseDefinitionsPayload({ agents: [] }), /エージェントとスキル/);
  assert.throws(() => parseDefinitionsPayload(null), /エージェントとスキル/);
});

test("確認カードに出す内容は件数を示し、形が違えば内容不明にする", () => {
  assert.equal(
    describeBackupPayload("definitions", definitionsPayload([1, 2], [1])),
    "エージェント 2 件 / スキル 1 件",
  );
  assert.equal(describeBackupPayload("definitions", {}), "エージェント 内容不明 / スキル 内容不明");
  assert.equal(describeBackupPayload("projects", []), "内容不明");
});
