// スキルの持ち出し / 取り込みの流れ。plan の分類・選択の状態遷移・送信の二重防止・失敗時の理由表示・
// 成功後の一覧取り直しを、通信と DOM を注入した fake で固定する (HTTP は fileSkillApi.test.ts)。
import assert from "node:assert/strict";
import test from "node:test";
import {
  SKILL_EXPORT_EMPTY_NOTE,
  SKILL_EXPORT_STARTED_NOTE,
  SKILL_IMPORT_NOT_ZIP_NOTE,
  skillImportDoneNote,
} from "../src/lib/fileSkills";
import {
  createSkillArchive,
  isSkillArchiveFileName,
  replaceableSkillNames,
  skillImportCounts,
  type SkillArchive,
  type SkillArchiveDeps,
} from "../src/lib/skillArchive";
import type { FileDownloadCheck, SandboxSkillsImportApply, SandboxSkillsImportPlan } from "../src/types";

const EXPORT_CHECK: FileDownloadCheck = {
  kind: "archive",
  name: "skills.zip",
  bytes: 2048,
  entries: 12,
  skipped: [],
};

const PLAN: SandboxSkillsImportPlan = {
  skills: [
    { name: "alpha", status: "new" },
    { name: "beta", status: "identical" },
    { name: "gamma", status: "conflict" },
    { name: "delta", status: "conflict" },
    { name: "broken", status: "invalid", reason: "frontmatter が読めません" },
  ],
  entries: 12,
  bytes: 2048,
};

const APPLY: SandboxSkillsImportApply = {
  applied: [
    { name: "alpha", relativePath: ".agents/skills/alpha/SKILL.md", fileVersion: "a".repeat(64), replaced: false },
    { name: "gamma", relativePath: ".agents/skills/gamma/SKILL.md", fileVersion: "b".repeat(64), replaced: true },
  ],
  skipped: [{ name: "beta", reason: "内容が同一" }],
  entries: 12,
  bytes: 2048,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type ArchiveCalls = {
  notes: { text: string; error: boolean }[];
  downloads: { url: string; name: string }[];
  reloads: number;
  selected: string[];
  planned: File[];
  applied: { file: File; replace: readonly string[] }[];
};

function setup(overrides: Partial<SkillArchiveDeps> = {}): {
  archive: SkillArchive;
  deps: SkillArchiveDeps;
  calls: ArchiveCalls;
} {
  const calls: ArchiveCalls = { notes: [], downloads: [], reloads: 0, selected: [], planned: [], applied: [] };
  const deps: SkillArchiveDeps = {
    checkExport: async () => EXPORT_CHECK,
    exportUrl: "http://localhost/api/skills/files/export",
    startDownload: (url, name) => {
      calls.downloads.push({ url, name });
    },
    planImport: async (file) => {
      calls.planned.push(file);
      return PLAN;
    },
    applyImport: async (file, replace) => {
      calls.applied.push({ file, replace });
      return APPLY;
    },
    reloadSkills: () => {
      calls.reloads += 1;
    },
    selectSkill: (relativePath) => {
      calls.selected.push(relativePath);
    },
    note: (text, error) => {
      calls.notes.push({ text, error });
    },
    ...overrides,
  };
  return { archive: createSkillArchive(deps), deps, calls };
}

/** 選択中の置き換え。plan を見ていない間は null */
function replaceOf(archive: SkillArchive): string[] | null {
  const flow = archive.state().import;
  return flow.status === "review" || flow.status === "applying" ? flow.replace : null;
}

test("plan の分類: 置き換えを選べるのは同名 (conflict) だけ", () => {
  assert.deepEqual(replaceableSkillNames(PLAN), ["gamma", "delta"]);
  // 取り込む件数は new と、選んだ conflict だけ (identical / invalid は常に対象外)
  assert.deepEqual(skillImportCounts(PLAN, []), { imported: 1, replaced: 0 });
  assert.deepEqual(skillImportCounts(PLAN, ["gamma"]), { imported: 2, replaced: 1 });
  assert.deepEqual(skillImportCounts(PLAN, ["gamma", "delta"]), { imported: 3, replaced: 2 });
});

test("選択の状態遷移: 既定は未選択で、選べるのは conflict の行だけ", async () => {
  const { archive } = setup();
  await archive.selectImportFile(new File(["zip"], "skills.zip"));
  assert.equal(archive.state().import.status, "review");
  assert.deepEqual(replaceOf(archive), []);

  // new / identical / invalid は選べない (取り込む / 書き込まない / スキップが status で決まる)
  archive.toggleReplace("alpha");
  archive.toggleReplace("beta");
  archive.toggleReplace("broken");
  assert.deepEqual(replaceOf(archive), []);

  archive.toggleReplace("gamma");
  assert.deepEqual(replaceOf(archive), ["gamma"]);
  archive.toggleReplace("delta");
  assert.deepEqual(replaceOf(archive), ["gamma", "delta"]);
  // 取消 (同じ行をもう一度押す)
  archive.toggleReplace("gamma");
  assert.deepEqual(replaceOf(archive), ["delta"]);

  archive.setReplaceAll(true);
  assert.deepEqual(replaceOf(archive), ["gamma", "delta"]);
  archive.setReplaceAll(false);
  assert.deepEqual(replaceOf(archive), []);
});

test("plan を取る前に ZIP かどうかを見て、ZIP でなければ理由だけを出す", async () => {
  const { archive, calls } = setup();
  await archive.selectImportFile(new File(["text"], "notes.txt"));
  assert.deepEqual(calls.planned, []);
  assert.equal(archive.state().import.status, "idle");
  assert.deepEqual(calls.notes, [{ text: SKILL_IMPORT_NOT_ZIP_NOTE, error: true }]);
  assert.equal(isSkillArchiveFileName("SKILLS.ZIP"), true);
  assert.equal(isSkillArchiveFileName("skills.zip.txt"), false);
});

test("適用は plan と同じ ZIP を送り、送信中の 2 回目は送らない", async () => {
  const pending = deferred<SandboxSkillsImportApply>();
  const applied: { file: File; replace: readonly string[] }[] = [];
  const { archive, calls } = setup({
    applyImport: (file, replace) => {
      applied.push({ file, replace });
      return pending.promise;
    },
  });
  const zip = new File(["zip"], "skills.zip");
  await archive.selectImportFile(zip);
  assert.equal(calls.planned[0], zip);
  archive.toggleReplace("gamma");

  const first = archive.applyImport();
  const second = archive.applyImport();
  assert.equal(applied.length, 1, "2 回目の apply も送っている");
  assert.equal(applied[0].file, zip, "plan と apply の ZIP が違う");
  assert.deepEqual(applied[0].replace, ["gamma"]);
  assert.equal(archive.state().import.status, "applying");

  pending.resolve(APPLY);
  await Promise.all([first, second]);
  assert.equal(archive.state().import.status, "applied");
  assert.equal(calls.reloads, 1, "適用後の一覧を取り直していない");
  assert.deepEqual(calls.notes, [{ text: skillImportDoneNote(2, 1), error: false }]);

  // 取り込んだスキルは一覧を取り直したあとで開く (ダイアログの下で開かない)
  assert.deepEqual(calls.selected, []);
  archive.closeImport();
  assert.equal(archive.state().import.status, "idle");
  assert.deepEqual(calls.selected, [".agents/skills/alpha/SKILL.md"]);
});

test("適用中はダイアログを閉じない (結果と一覧の取り直しを取りこぼさない)", async () => {
  const pending = deferred<SandboxSkillsImportApply>();
  const { archive } = setup({ applyImport: () => pending.promise });
  await archive.selectImportFile(new File(["zip"], "skills.zip"));
  const applying = archive.applyImport();
  archive.closeImport();
  assert.equal(archive.state().import.status, "applying");
  pending.resolve(APPLY);
  await applying;
  assert.equal(archive.state().import.status, "applied");
});

test("plan の応答を待つ間に閉じたら、その plan は出さない", async () => {
  const pending = deferred<SandboxSkillsImportPlan>();
  const { archive, calls } = setup({ planImport: () => pending.promise });
  const selected = archive.selectImportFile(new File(["zip"], "skills.zip"));
  assert.equal(archive.state().import.status, "planning");
  archive.closeImport();
  assert.equal(archive.state().import.status, "idle");

  pending.resolve(PLAN);
  await selected;
  assert.equal(archive.state().import.status, "idle");
  assert.deepEqual(calls.notes, []);
});

test("plan の失敗は理由をそのまま出し、ダイアログを開かない", async () => {
  const { archive, calls } = setup({
    planImport: async () => {
      throw new Error("ZIP ではありません");
    },
  });
  await archive.selectImportFile(new File(["zip"], "skills.zip"));
  assert.equal(archive.state().import.status, "idle");
  assert.deepEqual(calls.notes, [{ text: "ZIP ではありません", error: true }]);
});

test("適用の失敗は理由をそのまま出し、部分適用は出さずに一覧だけ取り直す", async () => {
  const { archive, calls } = setup({
    applyImport: async () => {
      throw new Error("取り込みに失敗しました");
    },
  });
  await archive.selectImportFile(new File(["zip"], "skills.zip"));
  await archive.applyImport();
  assert.equal(archive.state().import.status, "idle");
  assert.deepEqual(calls.notes, [{ text: "取り込みに失敗しました", error: true }]);
  assert.equal(calls.reloads, 1);
  assert.deepEqual(calls.selected, []);
});

test("持ち出し: 0 件は案内だけを出し、問題なければ保存を開始する", async () => {
  const empty = setup({ checkExport: async () => ({ ...EXPORT_CHECK, entries: 0 }) });
  await empty.archive.exportSkills();
  assert.deepEqual(empty.calls.downloads, []);
  assert.deepEqual(empty.calls.notes, [{ text: SKILL_EXPORT_EMPTY_NOTE, error: true }]);

  const ready = setup();
  await ready.archive.exportSkills();
  assert.deepEqual(ready.calls.downloads, [{ url: ready.deps.exportUrl, name: "skills.zip" }]);
  assert.deepEqual(ready.calls.notes, [{ text: SKILL_EXPORT_STARTED_NOTE, error: false }]);
});

test("持ち出しの失敗は理由をそのまま出し、送信中の 2 回目は送らない", async () => {
  const pending = deferred<FileDownloadCheck>();
  let checks = 0;
  const { archive, calls } = setup({
    checkExport: () => {
      checks += 1;
      return pending.promise;
    },
  });
  const first = archive.exportSkills();
  const second = archive.exportSkills();
  assert.equal(checks, 1);
  assert.equal(archive.state().exporting, true);
  pending.reject(new Error(".agents/skills が見つかりません"));
  await Promise.all([first, second]);
  assert.deepEqual(calls.notes, [{ text: ".agents/skills が見つかりません", error: true }]);
  assert.deepEqual(calls.downloads, []);
  assert.equal(archive.state().exporting, false);
});
