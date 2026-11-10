// 設定 → バックアップ の API (BFF)。外側 ZIP の形式検証・差分 / 適用・全削除・排他を、
// 実ファイルを読む ZIP リーダと最小のスタブで検証する。サンドボックス側のスキル検証は別テストが持つ。
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { BACKUP_MAX_BYTES } from "../src/backup/format";
import { BACKUP_JSON_MAX_BYTES } from "../src/schema";
import type { BackupModelResolver } from "../src/backup/plan";
import {
  SandboxRequestError,
  type SandboxSkillArchiveClient,
  type SandboxSkillFileClient,
  type SandboxWorkspaceClient,
} from "../src/sandbox/client";
import type { SandboxSkillImportPlanEntry } from "../src/sandbox/protocol";
import { createZipStream } from "../src/sandbox/zip";

const MANIFEST = (targets: readonly string[]): string =>
  JSON.stringify({ app: "u7agent", schema: 1, exportedAt: "2024-05-06T07:08:09.000Z", targets });

/** エントリ名 → 内容の ZIP を作る (復元の入力と、書き出し結果の検証に使う) */
async function zipEntries(entries: [string, string | Buffer][]): Promise<Buffer> {
  const stream = createZipStream(
    entries.map(([name, value]) => ({
      name,
      data: typeof value === "string" ? Buffer.from(value, "utf8") : value,
    })),
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function zip(entries: Record<string, string | Buffer>): Promise<Buffer> {
  return zipEntries(Object.entries(entries));
}

const bundle = (files: Record<string, string | Buffer>): Promise<Buffer> => zip(files);

function workspaceStub(state: { installed: string[] }): SandboxWorkspaceClient {
  return {
    previewFile: async () => ({ text: "" }),
    statFile: async (path: string) => ({ path }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
    getGitInfo: async () => ({ branch: null }),
    listSkills: async () => ({
      skills: state.installed.map((name) => ({ name, description: "", path: name, disableModelInvocation: false })),
    }),
    createDir: async (path: string) => ({ path }),
    renameEntry: async (path: string, name: string) => ({ path, name }),
    deleteFile: async () => {},
    deleteDirectory: async () => {},
    uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
    rawFile: async () => ({ status: 200, contentType: "image/png", body: null }),
    downloadEntry: async () => ({
      contentType: "application/octet-stream",
      contentDisposition: "attachment",
      body: null,
    }),
    checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
  } as SandboxWorkspaceClient;
}

interface SkillsFixture {
  workspace: SandboxWorkspaceClient;
  skillSandbox: SandboxSkillFileClient;
  skillArchive: SandboxSkillArchiveClient;
  state: {
    installed: string[];
    planEntries: SandboxSkillImportPlanEntry[];
    deleted: string[];
    applied: string[];
    /** apply で置換できずに skipped になるスキル (protectReason などの想定) */
    applySkipped: { name: string; reason: string }[];
  };
  /** 排他の検証用。設定すると listSkills がここで待つ */
  gate?: { entered: Promise<void>; release: () => void };
}

/** 共通スキルの一覧 / export / import / 削除だけを持つ最小のスタブ */
function skillsFixture(names: string[] = []): SkillsFixture {
  const state: SkillsFixture["state"] = {
    installed: [...names],
    planEntries: [],
    deleted: [],
    applied: [],
    applySkipped: [],
  };
  const fixture: SkillsFixture = {
    state,
    workspace: workspaceStub(state),
    skillSandbox: {
      getSkillFile: async (relativePath: string) => ({
        name: relativePath,
        description: "",
        body: "",
        relativePath,
        fileVersion: "a".repeat(64),
        mtime: 0,
        editable: false,
        reason: "read-only",
      }),
      createSkillFile: async () => ({ relativePath: "", fileVersion: "" }),
      saveSkillFile: async () => ({ relativePath: "", fileVersion: "" }),
      // サンドボックスは SKILL.md のパスだけを受け付ける (フォルダを渡すと 400)
      previewSkillDelete: async (relativePath: string) => {
        assert.match(relativePath, /^\.agents\/skills\/[^/]+\/SKILL\.md$/, "削除は SKILL.md のパスで要求する");
        return {
          relativePath,
          name: relativePath.split("/").at(-2) ?? "",
          dir: relativePath.replace(/\/SKILL\.md$/, ""),
          treeVersion: "b".repeat(64),
          entries: 1,
          bytes: 10,
          files: ["SKILL.md"],
        };
      },
      deleteSkillFolder: async (relativePath: string) => {
        assert.match(relativePath, /^\.agents\/skills\/[^/]+\/SKILL\.md$/, "削除は SKILL.md のパスで要求する");
        const name = relativePath.split("/").at(-2) ?? "";
        state.deleted.push(name);
        state.installed = state.installed.filter((item) => item !== name);
      },
    },
    skillArchive: {
      exportSkills: async () => ({
        contentType: "application/zip",
        contentDisposition: 'attachment; filename="skills.zip"',
        body: new Blob([new Uint8Array(await zip({}))]).stream(),
      }),
      checkSkillsExport: async () => ({
        kind: "archive",
        name: "skills.zip",
        bytes: 10,
        entries: state.installed.length,
        skipped: [],
      }),
      importSkills: async (input) => {
        if (input.dryRun.length > 0) {
          return { skills: state.planEntries, entries: state.planEntries.length, bytes: 10 };
        }
        const skipped = state.applySkipped;
        const applied = state.planEntries
          .filter((entry) => entry.status === "new" || entry.status === "conflict")
          .filter((entry) => !skipped.some((item) => item.name === entry.name))
          .map((entry) => ({
            name: entry.name,
            relativePath: `.agents/skills/${entry.name}/SKILL.md`,
            fileVersion: "c".repeat(64),
            replaced: entry.status === "conflict",
          }));
        state.applied.push(...applied.map((entry) => entry.name));
        return { applied, skipped, entries: state.planEntries.length, bytes: 10 };
      },
    },
  };
  return fixture;
}

async function makeApp(options: {
  skills?: SkillsFixture;
  backupModels?: BackupModelResolver;
  withoutArchive?: boolean;
  withoutWorkspace?: boolean;
}) {
  return createBffApp({
    cwd: mkdtempSync(join(tmpdir(), "u7agent-backup-api-")),
    sessionStoreDir: null,
    pi: null,
    workspace: options.skills && !options.withoutWorkspace ? options.skills.workspace : null,
    skillSandbox: options.skills ? options.skills.skillSandbox : null,
    skillArchiveSandbox: options.skills && !options.withoutArchive ? options.skills.skillArchive : null,
    ...(options.backupModels ? { backupModels: options.backupModels } : {}),
  });
}

type BffApp = Awaited<ReturnType<typeof createBffApp>>["app"];

function restore(app: BffApp, body: Buffer, query = "") {
  return app.request(`/api/backup/restore${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: new Uint8Array(body),
  });
}

async function exportBackup(app: BffApp, targets: readonly string[]): Promise<Buffer> {
  const query = targets.map((target) => `targets=${target}`).join("&");
  const response = await app.request(`/api/backup/export?${query}`);
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}

test("書き出す → 変更する → 復元で元に戻り、2 回目の plan は変更なしになる", async () => {
  const bff = await makeApp({});
  try {
    const promptResponse = await bff.app.request("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Greeting", prompt: "hello" }),
    });
    assert.equal(promptResponse.status, 201);
    const { prompt } = (await promptResponse.json()) as { prompt: { id: string } };
    const created = await bff.app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Coder", systemPrompt: "code", promptIds: [prompt.id] }),
    });
    assert.equal(created.status, 201);
    const { agent } = (await created.json()) as { agent: { id: string } };

    const check = await bff.app.request("/api/backup/export/check?targets=prompts&targets=agents");
    assert.equal(check.status, 200);
    const exportCheck = (await check.json()) as { fileName: string; entries: { target: string; count: number }[] };
    assert.match(exportCheck.fileName, /^u7agent-backup-\d{4}-\d{2}-\d{2}\.zip$/);
    assert.deepEqual(
      exportCheck.entries.map((entry) => [entry.target, entry.count]),
      [
        ["prompts", 1],
        ["agents", 2],
      ],
    );

    const backup = await exportBackup(bff.app, ["prompts", "agents"]);

    // 既存を変えてから戻す (プロンプトの本文変更 + エージェント追加)
    await bff.app.request(`/api/prompts/${prompt.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Changed" }),
    });
    await bff.app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Extra" }),
    });

    const planResponse = await restore(bff.app, backup, "?dryRun=true");
    assert.equal(planResponse.status, 200);
    const plan = (await planResponse.json()) as {
      changed: boolean;
      blocked: boolean;
      plans: { target: string; counts: Record<string, number>; items: { id: string; status: string }[] }[];
    };
    assert.equal(plan.changed, true);
    assert.equal(plan.blocked, false);
    const agentPlan = plan.plans.find((item) => item.target === "agents");
    // バックアップの 2 体は同一、後から足した 1 体だけが削除対象
    assert.deepEqual(agentPlan?.counts, { added: 0, updated: 0, identical: 2, removed: 1, reordered: 0 });
    // 名前が変わった行は更新で、削除対象もプレビューに出る
    assert.deepEqual(
      plan.plans.find((item) => item.target === "prompts")?.items.map((item) => item.status),
      ["updated"],
    );

    const applied = await restore(bff.app, backup);
    assert.equal(applied.status, 200);
    const result = (await applied.json()) as { complete: boolean; failed: unknown[] };
    assert.equal(result.complete, true);
    assert.deepEqual(result.failed, []);

    const prompts = (await (await bff.app.request("/api/prompts")).json()) as {
      prompts: { id: string; label: string }[];
    };
    assert.equal(prompts.prompts.find((item) => item.id === prompt.id)?.label, "Greeting");
    const agents = (await (await bff.app.request("/api/agents")).json()) as {
      agents: { id: string; name: string }[];
    };
    assert.deepEqual(agents.agents.map((item) => item.name).sort(), ["Coder", "ずんだもん"]);
    assert.ok(agents.agents.some((item) => item.id === agent.id));

    const again = await restore(bff.app, backup, "?dryRun=true");
    const repeat = (await again.json()) as { changed: boolean; blocked: boolean };
    assert.equal(repeat.changed, false);
    assert.equal(repeat.blocked, false);
  } finally {
    await bff.close();
  }
});

test("manifest に無い対象は変更しない (エージェントだけのバックアップ)", async () => {
  const bff = await makeApp({});
  try {
    await bff.app.request("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Keep me", prompt: "text" }),
    });
    const backup = await exportBackup(bff.app, ["agents"]);
    await bff.app.request("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Added later", prompt: "text" }),
    });
    await bff.app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Extra" }),
    });

    const result = await restore(bff.app, backup);
    assert.equal(result.status, 200);
    const prompts = (await (await bff.app.request("/api/prompts")).json()) as {
      prompts: { kind: string; label: string }[];
    };
    assert.deepEqual(
      prompts.prompts.filter((item) => item.kind === "custom").map((item) => item.label),
      ["Keep me", "Added later"],
    );
  } finally {
    await bff.close();
  }
});

test("壊れたバンドルは 400 で断り、何も変更しない", async () => {
  const bff = await makeApp({});
  try {
    const prompts = JSON.stringify({ prompts: [{ id: "p-1", label: "L", prompt: "P" }] });
    const agents = JSON.stringify({
      agents: [{ id: "a-1", name: "A", description: "", systemPrompt: "" }],
    });
    const cases: [string, Promise<Buffer>][] = [
      [
        "未知のエントリ",
        bundle({ "manifest.json": MANIFEST(["prompts"]), "prompts.json": prompts, "extra.json": "{}" }),
      ],
      [
        "重複したエントリ",
        bundle({ "manifest.json": MANIFEST(["prompts"]), "prompts.json": prompts, "agents.json": agents }),
      ],
      ["欠けたエントリ", bundle({ "manifest.json": MANIFEST(["prompts", "agents"]), "prompts.json": prompts })],
      [
        "app の不一致",
        bundle({ "manifest.json": MANIFEST(["prompts"]).replace("u7agent", "other"), "prompts.json": prompts }),
      ],
      [
        "schema の不一致",
        bundle({ "manifest.json": MANIFEST(["prompts"]).replace('"schema":1', '"schema":2'), "prompts.json": prompts }),
      ],
      [
        "manifest の未知キー",
        bundle({
          "manifest.json": `{"app":"u7agent","schema":1,"exportedAt":"x","targets":["prompts"],"x":1}`,
          "prompts.json": prompts,
        }),
      ],
      [
        "組み込みプロンプトの混入",
        bundle({
          "manifest.json": MANIFEST(["prompts"]),
          "prompts.json": JSON.stringify({
            prompts: [{ id: "prompt-builtin-check-tests", label: "L", prompt: "P" }],
          }),
        }),
      ],
      [
        "組み込みエージェントの混入",
        bundle({
          "manifest.json": MANIFEST(["agents"]),
          "agents.json": JSON.stringify({
            agents: [{ id: "agent-general", name: "A", description: "", systemPrompt: "" }],
          }),
        }),
      ],
      [
        "ID の重複",
        bundle({
          "manifest.json": MANIFEST(["prompts"]),
          "prompts.json": JSON.stringify({
            prompts: [
              { id: "p-1", label: "A", prompt: "P" },
              { id: "p-1", label: "B", prompt: "P" },
            ],
          }),
        }),
      ],
      [
        "同じ名前のエントリ",
        zipEntries([
          ["manifest.json", MANIFEST(["prompts"])],
          ["prompts.json", prompts],
          ["prompts.json", prompts],
        ]),
      ],
      [
        "親ディレクトリへ出る名前",
        zipEntries([
          ["manifest.json", MANIFEST(["prompts"])],
          ["../prompts.json", prompts],
        ]),
      ],
      [
        "空の ID",
        bundle({
          "manifest.json": MANIFEST(["prompts"]),
          "prompts.json": JSON.stringify({ prompts: [{ id: " ", label: "A", prompt: "P" }] }),
        }),
      ],
    ];
    for (const [name, archive] of cases) {
      const response = await restore(bff.app, await archive);
      assert.equal(response.status, 400, name);
    }
    // manifest に無い対象を query で指定しても 400 (部分集合だけを許可する)
    const outside = await restore(
      bff.app,
      await bundle({ "manifest.json": MANIFEST(["prompts"]), "prompts.json": prompts }),
      "?targets=agents",
    );
    assert.equal(outside.status, 400);
    assert.equal(
      ((await (await bff.app.request("/api/prompts")).json()) as { prompts: unknown[] }).prompts.filter(
        (item) => (item as { kind: string }).kind === "custom",
      ).length,
      0,
    );
  } finally {
    await bff.close();
  }
});

test("使用中のプロンプトが削除対象なら blocked を返し、apply は 409 で何も変更しない", async () => {
  const bff = await makeApp({});
  try {
    const created = await bff.app.request("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "In use", prompt: "text" }),
    });
    const { prompt } = (await created.json()) as { prompt: { id: string } };
    await bff.app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "User", promptIds: [prompt.id] }),
    });

    // 使用中のマスタが入っていないバンドル (= 削除対象になる)
    const archive = await bundle({
      "manifest.json": MANIFEST(["prompts"]),
      "prompts.json": JSON.stringify({ prompts: [{ id: "prompt-other", label: "Other", prompt: "P" }] }),
    });
    const plan = await restore(bff.app, archive, "?dryRun=true");
    assert.equal(plan.status, 200);
    const body = (await plan.json()) as {
      blocked: boolean;
      plans: { blocker: { code: string; names: string[] } | null }[];
    };
    assert.equal(body.blocked, true);
    assert.equal(body.plans[0].blocker?.code, "prompt_in_use");
    assert.deepEqual(body.plans[0].blocker?.names, ["In use"]);

    const applied = await restore(bff.app, archive);
    assert.equal(applied.status, 409);
    const failure = (await applied.json()) as { code: string };
    assert.equal(failure.code, "blocked");
    const prompts = (await (await bff.app.request("/api/prompts")).json()) as {
      prompts: { id: string; kind: string }[];
    };
    assert.ok(prompts.prompts.some((item) => item.id === prompt.id));
  } finally {
    await bff.close();
  }
});

test("スキルの invalid は skills だけをブロックし、skills を外せばエージェントを復元できる", async () => {
  const skills = skillsFixture(["keep", "old"]);
  skills.state.planEntries = [
    { name: "keep", status: "conflict" },
    { name: "fresh", status: "new" },
    { name: "broken", status: "invalid", reason: "SKILL.md を読めません" },
  ];
  const bff = await makeApp({ skills });
  try {
    await bff.app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Temp" }),
    });
    const backup = await exportBackup(bff.app, ["agents", "skills"]);
    await bff.app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Extra" }),
    });

    const blockedPlan = await restore(bff.app, backup, "?dryRun=true");
    const planBody = (await blockedPlan.json()) as {
      blocked: boolean;
      plans: { target: string; blocker: { code: string; names: string[] } | null }[];
    };
    assert.equal(planBody.blocked, true);
    const skillPlan = planBody.plans.find((item) => item.target === "skills");
    assert.equal(skillPlan?.blocker?.code, "skill_invalid");
    assert.deepEqual(skillPlan?.blocker?.names, ["broken"]);

    assert.equal((await restore(bff.app, backup)).status, 409);

    const narrowed = await restore(bff.app, backup, "?targets=agents");
    assert.equal(narrowed.status, 200);
    const agents = (await (await bff.app.request("/api/agents")).json()) as { agents: { name: string }[] };
    assert.deepEqual(agents.agents.map((item) => item.name).sort(), ["Temp", "ずんだもん"]);
    assert.deepEqual(skills.state.deleted, []);
  } finally {
    await bff.close();
  }
});

test("スキルは追加してから、バックアップに無い既存を削除する", async () => {
  const skills = skillsFixture(["keep", "old"]);
  skills.state.planEntries = [
    { name: "keep", status: "conflict" },
    { name: "fresh", status: "new" },
  ];
  const bff = await makeApp({ skills });
  try {
    const backup = await exportBackup(bff.app, ["skills"]);
    const result = await restore(bff.app, backup, "?targets=skills");
    assert.equal(result.status, 200);
    const body = (await result.json()) as { complete: boolean; applied: { target: string }[] };
    assert.equal(body.complete, true);
    assert.deepEqual(skills.state.applied, ["keep", "fresh"]);
    assert.deepEqual(skills.state.deleted, ["old"]);
    assert.deepEqual(
      body.applied.map((item) => item.target),
      ["skills"],
    );
  } finally {
    await bff.close();
  }
});

test("全削除はユーザー定義のエージェント / 自作プロンプト / 共通スキルだけを消す", async () => {
  const skills = skillsFixture(["alpha", "beta"]);
  const bff = await makeApp({ skills });
  try {
    await bff.app.request("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "L", prompt: "P" }),
    });
    const response = await bff.app.request("/api/backup/reset", { method: "POST" });
    assert.equal(response.status, 200);
    const result = (await response.json()) as { complete: boolean; agents: number; prompts: number; skills: number };
    assert.equal(result.complete, true);
    assert.equal(result.agents, 1);
    assert.equal(result.prompts, 1);
    assert.equal(result.skills, 2);

    const prompts = (await (await bff.app.request("/api/prompts")).json()) as { prompts: { kind: string }[] };
    assert.deepEqual(
      prompts.prompts.map((item) => item.kind),
      ["builtin", "builtin", "builtin"],
    );
    const agents = (await (await bff.app.request("/api/agents")).json()) as { agents: unknown[] };
    assert.deepEqual(agents.agents, []);
  } finally {
    await bff.close();
  }
});

test("モデルがカタログに無いときだけ落とし、thinkingLevel は残す", async () => {
  const bff = await makeApp({ backupModels: () => "not_in_catalog" });
  try {
    const archive = await bundle({
      "manifest.json": MANIFEST(["agents"]),
      "agents.json": JSON.stringify({
        agents: [
          {
            id: "agent-a",
            name: "A",
            description: "",
            systemPrompt: "",
            model: { provider: "p", id: "gone" },
            thinkingLevel: "high",
          },
        ],
      }),
    });
    const plan = await restore(bff.app, archive, "?dryRun=true");
    const planBody = (await plan.json()) as {
      plans: { warnings: { code: string; name?: string }[]; counts: Record<string, number> }[];
    };
    assert.deepEqual(
      planBody.plans[0].warnings.map((warning) => warning.code),
      ["model_unavailable"],
    );
    assert.equal((await restore(bff.app, archive)).status, 200);
    const agents = (await (await bff.app.request("/api/agents")).json()) as {
      agents: { id: string; model?: unknown; thinkingLevel?: string }[];
    };
    const restored = agents.agents.find((item) => item.id === "agent-a");
    assert.equal(restored?.model, undefined);
    assert.equal(restored?.thinkingLevel, "high");
    // 実効値で比べるため、同じバンドルの再復元は変更なしになる
    const again = (await (await restore(bff.app, archive, "?dryRun=true")).json()) as { changed: boolean };
    assert.equal(again.changed, false);
  } finally {
    await bff.close();
  }
});

test("モデル一覧が取れないときは保持して警告する", async () => {
  const bff = await makeApp({ backupModels: () => "unknown" });
  try {
    const archive = await bundle({
      "manifest.json": MANIFEST(["agents"]),
      "agents.json": JSON.stringify({
        agents: [
          {
            id: "agent-a",
            name: "A",
            description: "",
            systemPrompt: "",
            model: { provider: "p", id: "m" },
            promptIds: ["prompt-missing"],
          },
        ],
      }),
    });
    const plan = (await (await restore(bff.app, archive, "?dryRun=true")).json()) as {
      plans: { warnings: { code: string }[]; items: { status: string }[] }[];
    };
    assert.deepEqual(
      plan.plans[0].warnings.map((warning) => warning.code),
      ["prompt_reference_removed", "model_unknown", "model_settings_missing"],
    );
    assert.equal((await restore(bff.app, archive)).status, 200);
    const agents = (await (await bff.app.request("/api/agents")).json()) as {
      agents: { id: string; model?: { id: string }; prompts?: unknown[] }[];
    };
    const restored = agents.agents.find((item) => item.id === "agent-a");
    assert.equal(restored?.model?.id, "m");
    assert.equal(restored?.prompts, undefined);
    const again = (await (await restore(bff.app, archive, "?dryRun=true")).json()) as { changed: boolean };
    assert.equal(again.changed, false);
  } finally {
    await bff.close();
  }
});

test("サンドボックス未設定では skills をブロックし、export は 503 になる", async () => {
  const bff = await makeApp({ withoutArchive: true, withoutWorkspace: true });
  try {
    const check = await bff.app.request("/api/backup/export/check?targets=skills");
    assert.equal(check.status, 200);
    const body = (await check.json()) as { entries: { available?: boolean; reason?: string }[] };
    assert.equal(body.entries[0].available, false);
    assert.ok(body.entries[0].reason);

    const exported = await bff.app.request("/api/backup/export?targets=skills");
    assert.equal(exported.status, 503);

    const plan = (await (
      await restore(
        bff.app,
        await bundle({ "manifest.json": MANIFEST(["skills"]), "skills.zip": await zip({}) }),
        "?dryRun=true",
      )
    ).json()) as { blocked: boolean; plans: { blocker: { code: string } | null }[] };
    assert.equal(plan.blocked, true);
    assert.equal(plan.plans[0].blocker?.code, "skill_unavailable");
  } finally {
    await bff.close();
  }
});

test("スキルの適用だけが失敗したら partial を返し、再実行で残りを適用できる", async () => {
  const skills = skillsFixture(["old"]);
  skills.state.planEntries = [{ name: "fresh", status: "new" }];
  let failApply = true;
  const apply = skills.skillArchive.importSkills;
  skills.skillArchive.importSkills = async (input) => {
    if (input.dryRun.length === 0 && failApply) throw new Error("サンドボックスへ接続できません");
    return apply(input);
  };
  const bff = await makeApp({ skills });
  try {
    await bff.app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Temp" }),
    });
    const backup = await exportBackup(bff.app, ["agents", "skills"]);
    await bff.app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Extra" }),
    });

    const first = await restore(bff.app, backup);
    assert.equal(first.status, 200);
    const result = (await first.json()) as {
      complete: boolean;
      applied: { target: string }[];
      failed: { target: string }[];
    };
    // DB は適用済みで、スキルだけが失敗している (何度も作り直さない)
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.applied.map((item) => item.target),
      ["agents"],
    );
    assert.deepEqual(
      result.failed.map((item) => item.target),
      ["skills"],
    );
    const agents = (await (await bff.app.request("/api/agents")).json()) as { agents: { name: string }[] };
    assert.deepEqual(agents.agents.map((item) => item.name).sort(), ["Temp", "ずんだもん"]);

    // 再実行では DB の差分が 0 になり、スキルだけが適用される
    failApply = false;
    const retry = await restore(bff.app, backup);
    const second = (await retry.json()) as { complete: boolean; applied: { target: string }[] };
    assert.equal(second.complete, true);
    assert.deepEqual(
      second.applied.map((item) => item.target),
      ["skills"],
    );
    assert.deepEqual(skills.state.applied, ["fresh"]);
    assert.deepEqual(skills.state.deleted, ["old"]);
  } finally {
    await bff.close();
  }
});

test(".agents/skills が無いときは 0 件として扱い、空の skills.zip を書き出す", async () => {
  const skills = skillsFixture([]);
  skills.skillArchive.checkSkillsExport = async () => {
    throw new SandboxRequestError(".agents/skills が見つかりません", 404);
  };
  skills.skillArchive.exportSkills = async () => {
    throw new SandboxRequestError(".agents/skills が見つかりません", 404);
  };
  const bff = await makeApp({ skills });
  try {
    const check = await bff.app.request("/api/backup/export/check?targets=skills");
    const body = (await check.json()) as { entries: { count: number; available?: boolean }[] };
    assert.equal(body.entries[0].count, 0);
    assert.equal(body.entries[0].available, true);

    const exported = await bff.app.request("/api/backup/export?targets=skills");
    assert.equal(exported.status, 200);
    assert.ok((await exported.arrayBuffer()).byteLength > 0);
  } finally {
    await bff.close();
  }
});

test("スキル一覧が取れないときは skills をブロックし、置換を始めない", async () => {
  const skills = skillsFixture(["alpha"]);
  skills.state.planEntries = [{ name: "fresh", status: "new" }];
  skills.workspace = {
    ...skills.workspace,
    listSkills: async () => {
      throw new SandboxRequestError("サンドボックスのスキル一覧を取得できません", 502);
    },
  } as SandboxWorkspaceClient;
  const bff = await makeApp({ skills });
  try {
    const backup = await exportBackup(bff.app, ["skills"]);
    const plan = (await (await restore(bff.app, backup, "?dryRun=true&targets=skills")).json()) as {
      blocked: boolean;
      plans: { blocker: { code: string } | null }[];
    };
    assert.equal(plan.blocked, true);
    assert.equal(plan.plans[0].blocker?.code, "skill_unreadable");

    assert.equal((await restore(bff.app, backup, "?targets=skills")).status, 409);
    // 何も置換していない (全置換を黙って部分適用にしない)
    assert.deepEqual(skills.state.applied, []);
    assert.deepEqual(skills.state.deleted, []);
  } finally {
    await bff.close();
  }
});

test("置換できなかったスキル (skipped) は partial にし、削除まで進めない", async () => {
  const skills = skillsFixture(["keep", "old"]);
  skills.state.planEntries = [
    { name: "keep", status: "conflict" },
    { name: "fresh", status: "new" },
  ];
  skills.state.applySkipped = [{ name: "keep", reason: "SKILL.md がシンボリックリンクのため置換できません" }];
  const bff = await makeApp({ skills });
  try {
    const backup = await exportBackup(bff.app, ["skills"]);
    const response = await restore(bff.app, backup, "?targets=skills");
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      complete: boolean;
      applied: { target: string }[];
      failed: { target: string; message: string }[];
    };
    assert.equal(result.complete, false);
    assert.deepEqual(result.applied, []);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].message, /keep/);
    // 置換できていないので、バックアップに無いスキルの削除には進まない
    assert.deepEqual(skills.state.deleted, []);
  } finally {
    await bff.close();
  }
});

test("スキルを選択していない復元では、既存の共通スキル名を警告にしない", async () => {
  const skills = skillsFixture(["alpha"]);
  const bff = await makeApp({ skills });
  try {
    const archive = await bundle({
      "manifest.json": MANIFEST(["agents"]),
      "agents.json": JSON.stringify({
        agents: [
          {
            id: "agent-a",
            name: "A",
            description: "",
            systemPrompt: "",
            commonSkillNames: ["alpha"],
            builtinSkillNames: ["not-a-skill"],
          },
        ],
      }),
    });
    const plan = (await (await restore(bff.app, archive, "?dryRun=true")).json()) as {
      plans: { target: string; warnings: { code: string; name?: string }[] }[];
    };
    const agentPlan = plan.plans.find((item) => item.target === "agents");
    // 一覧にある共通スキルは警告しない。組み込みは既知の一覧と照合するので警告になる
    assert.deepEqual(
      agentPlan?.warnings.map((warning) => [warning.code, warning.name]),
      [["builtin_skill_not_found", "not-a-skill"]],
    );
  } finally {
    await bff.close();
  }
});

test("JSON の合計が上限を超えるバンドルは 400 で断る", async () => {
  const bff = await makeApp({});
  try {
    // 1 エントリで上限を超える (展開前にサイズで止める)
    const oversized = Buffer.alloc(BACKUP_JSON_MAX_BYTES + 1024, 0x20);
    const archive = await bundle({
      "manifest.json": MANIFEST(["agents"]),
      "agents.json": oversized,
    });
    const response = await restore(bff.app, archive);
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /Backup JSON is too large/);
  } finally {
    await bff.close();
  }
});

test("content-length が上限を超える復元は本文を読まずに 413", async () => {
  const bff = await makeApp({});
  try {
    const response = await bff.app.request("/api/backup/restore", {
      method: "POST",
      headers: { "Content-Type": "application/zip", "Content-Length": String(BACKUP_MAX_BYTES + 1) },
      body: "x",
    });
    assert.equal(response.status, 413);
  } finally {
    await bff.close();
  }
});

test("進行中の操作があると 409 busy になり、状態を混ぜない", async () => {
  const skills = skillsFixture(["alpha"]);
  skills.state.planEntries = [{ name: "alpha", status: "identical" }];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  })();
  const workspace = skills.workspace;
  skills.workspace = {
    ...workspace,
    listSkills: async (dir: string) => {
      entered.resolve();
      await gate;
      return workspace.listSkills(dir);
    },
  } as SandboxWorkspaceClient;
  const bff = await makeApp({ skills });
  try {
    const archive = await bundle({ "manifest.json": MANIFEST(["skills"]), "skills.zip": await zip({}) });
    const first = restore(bff.app, archive, "?dryRun=true");
    await entered.promise;
    const second = await bff.app.request("/api/backup/export/check");
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { code: string }).code, "busy");
    release();
    assert.equal((await first).status, 200);
    // 解放後は再試行できる
    assert.equal((await bff.app.request("/api/backup/export/check")).status, 200);
  } finally {
    release();
    await bff.close();
  }
});

test("アプリデータが使えない復元は 503 not_stored", async () => {
  const bff = await makeApp({});
  try {
    const archive = await bundle({
      "manifest.json": MANIFEST(["agents"]),
      "agents.json": JSON.stringify({ agents: [] }),
    });
    bff.appDb.close();
    const response = await restore(bff.app, archive);
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { state?: string }).state, "not_stored");
  } finally {
    await bff.close();
  }
});

test("復元の受信が途中で切れても一時ディレクトリを残さない", async () => {
  const bff = await makeApp({});
  const tempRoot = mkdtempSync(join(tmpdir(), "u7agent-backup-abort-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tempRoot;
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
        controller.error(new Error("connection aborted"));
      },
    });
    const response = await bff.app.request("/api/backup/restore", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    assert.notEqual(response.status, 200);
    // 後始末は finally で走る。消えていることを確認する
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(readdirSync(tempRoot), []);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await bff.close();
  }
});
