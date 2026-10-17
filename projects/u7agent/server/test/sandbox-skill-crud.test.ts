// 共通スキル (`.agents/skills`) の GUI CRUD をサンドボックスの実ファイルで検証する。listen せず
// app.request() で叩き、NDJSON のツール実行 (SDK の edit / write) と競合させて観測できる契約だけを見る。
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { createSandboxService, type SandboxService } from "../src/sandbox/service";
import type {
  SandboxSkillCreateResult,
  SandboxSkillDeletePreview,
  SandboxSkillFileDetail,
  SandboxSkillSaveResult,
} from "../src/sandbox/protocol";

const TOKEN = "test-sandbox-token-0123456789abcdef";
const SKILL_PATH = ".agents/skills/alpha/SKILL.md";

type App = SandboxService["app"];

const HAS_SYMLINK = (() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sbx-skill-symlink-check-"));
  try {
    symlinkSync(dir, join(dir, "link"));
    return true;
  } catch {
    return false;
  }
})();
const SYMLINK_SKIP_REASON = "symlinks are not available on this platform";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

/** 共通スキル 1 件と付随ファイルを持つワークスペースを作る */
async function makeWorkspace(prefix: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `pi-sbx-${prefix}-`));
  await mkdir(join(root, ".agents/skills/alpha/refs"), { recursive: true });
  await writeFile(
    join(root, SKILL_PATH),
    '---\nname: alpha\ndescription: "元の説明"\n# コメント\nx-extra: 1\n---\n元の本文\n',
    "utf8",
  );
  await writeFile(join(root, ".agents/skills/alpha/refs/note.txt"), "note", "utf8");
  return root;
}

async function detail(app: App, relativePath = SKILL_PATH): Promise<SandboxSkillFileDetail> {
  const response = await app.request(`/v1/skills/file?relativePath=${encodeURIComponent(relativePath)}`, {
    headers: authHeaders(),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as SandboxSkillFileDetail;
}

async function preview(app: App, relativePath = SKILL_PATH): Promise<SandboxSkillDeletePreview> {
  const response = await app.request(
    `/v1/skills/file/delete-preview?relativePath=${encodeURIComponent(relativePath)}`,
    { headers: authHeaders() },
  );
  assert.equal(response.status, 200);
  return (await response.json()) as SandboxSkillDeletePreview;
}

async function save(
  app: App,
  body: Record<string, unknown>,
): Promise<{ status: number; body: SandboxSkillSaveResult & { error?: string } }> {
  const response = await app.request("/v1/skills/file", {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as SandboxSkillSaveResult & { error?: string } };
}

async function create(
  app: App,
  body: Record<string, unknown>,
): Promise<{ status: number; body: SandboxSkillCreateResult & { error?: string } }> {
  const response = await app.request("/v1/skills/file", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as SandboxSkillCreateResult & { error?: string } };
}

async function remove(app: App, relativePath: string, treeVersion: string): Promise<number> {
  const response = await app.request(
    `/v1/skills/file?relativePath=${encodeURIComponent(relativePath)}&treeVersion=${encodeURIComponent(treeVersion)}`,
    { method: "DELETE", headers: authHeaders() },
  );
  return response.status;
}

/** SDK の edit / write を NDJSON のツール実行として叩く (モデルの経路と同じ service の入口) */
async function executeTool(
  app: App,
  tool: string,
  params: Record<string, unknown>,
  cwd = "",
): Promise<{ result?: unknown; error?: string }> {
  const response = await app.request(`/v1/tools/${tool}/execute`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ toolCallId: "call-1", params, cwd }),
  });
  assert.equal(response.status, 200);
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; payload?: unknown; message?: string });
  const error = events.find((event) => event.type === "error");
  if (error) return { error: error.message ?? "unknown" };
  return { result: events.find((event) => event.type === "result")?.payload };
}

test("編集内容は SDK の name / description と trim していない本文を返す", async () => {
  const root = await makeWorkspace("skill-detail");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const body = await detail(app);
  assert.equal(body.name, "alpha");
  assert.equal(body.description, "元の説明");
  assert.equal(body.body, "\n元の本文\n");
  assert.equal(body.relativePath, SKILL_PATH);
  assert.match(body.fileVersion, /^[0-9a-f]{64}$/);
  assert.equal(body.editable, true);
  assert.equal(body.reason, undefined);
});

test("保存は説明と本文だけを差し替え、同じ内容の再保存ではバイト列と mtime を変えない", async () => {
  const root = await makeWorkspace("skill-save");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const before = await detail(app);
  const mtimeBefore = (await stat(join(root, SKILL_PATH))).mtimeMs;
  const noop = await save(app, {
    relativePath: SKILL_PATH,
    fileVersion: before.fileVersion,
    description: "元の説明",
    body: before.body,
  });
  assert.equal(noop.status, 200);
  assert.equal(noop.body.fileVersion, before.fileVersion);
  // 変更なしの保存は write を起こさない (バイト列も mtime も変わらない)
  assert.equal((await stat(join(root, SKILL_PATH))).mtimeMs, mtimeBefore);

  const changed = await save(app, {
    relativePath: SKILL_PATH,
    fileVersion: before.fileVersion,
    description: "新しい説明",
    body: "\n新しい本文\n",
  });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.body.fileVersion, before.fileVersion);
  const text = await readFile(join(root, SKILL_PATH), "utf8");
  assert.equal(text, '---\nname: alpha\ndescription: "新しい説明"\n# コメント\nx-extra: 1\n---\n新しい本文\n');
  // 保存成功時の fileVersion は公開した内容の版
  assert.equal((await detail(app)).fileVersion, changed.body.fileVersion);
});

test("版が一致しない保存は 409 で、name の変更要求は受け付けない", async () => {
  const root = await makeWorkspace("skill-version");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const before = await detail(app);
  const stale = await save(app, {
    relativePath: SKILL_PATH,
    fileVersion: "0".repeat(64),
    description: "x",
    body: "y",
  });
  assert.equal(stale.status, 409);
  assert.match(String(stale.body.error), /競合/);
  assert.equal(
    await readFile(join(root, SKILL_PATH), "utf8"),
    '---\nname: alpha\ndescription: "元の説明"\n# コメント\nx-extra: 1\n---\n元の本文\n',
  );

  const renamed = await save(app, {
    relativePath: SKILL_PATH,
    fileVersion: before.fileVersion,
    name: "beta",
    description: "説明だけ変更",
    body: before.body,
  });
  assert.equal(renamed.status, 200);
  assert.equal(parseFrontmatter(await readFile(join(root, SKILL_PATH), "utf8")).frontmatter.name, "alpha");
  assert.equal((await detail(app)).name, "alpha");
});

test("frontmatter が無い / 複雑すぎるファイルは理由付きで保存を拒否し、変更しない", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-skill-refuse-"));
  await mkdir(join(root, ".agents/skills/broken"), { recursive: true });
  await writeFile(
    join(root, ".agents/skills/broken/SKILL.md"),
    "---\ndescription: &a x\nother: *a\n---\nbody\n",
    "utf8",
  );
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const detailBody = await detail(app, ".agents/skills/broken/SKILL.md");
  assert.equal(detailBody.editable, false);
  assert.match(String(detailBody.reason), /anchor/);
  const refused = await save(app, {
    relativePath: ".agents/skills/broken/SKILL.md",
    fileVersion: detailBody.fileVersion,
    description: "y",
    body: detailBody.body,
  });
  assert.equal(refused.status, 400);
  assert.equal(
    await readFile(join(root, ".agents/skills/broken/SKILL.md"), "utf8"),
    "---\ndescription: &a x\nother: *a\n---\nbody\n",
  );
});

test("同名 / 既存ディレクトリ / 非発見の内容は作成できない", async () => {
  const root = await makeWorkspace("skill-create");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  // 既存の同名スキル (SDK が発見する名前)
  const duplicate = await create(app, { name: "alpha", description: "d", body: "b" });
  assert.equal(duplicate.status, 409);
  assert.match(String(duplicate.body.error), /既に存在します/);
  // 発見されないが既存のディレクトリ (降順の 404 ではなく 409)
  await mkdir(join(root, ".agents/skills/empty-dir"), { recursive: true });
  const existingDir = await create(app, { name: "empty-dir", description: "d", body: "b" });
  assert.equal(existingDir.status, 409);
  // SDK の名前規則 (大文字・空白) は拒否する
  assert.equal((await create(app, { name: "Bad Name", description: "d", body: "b" })).status, 400);
  assert.equal((await create(app, { name: "-bad", description: "d", body: "b" })).status, 400);
  // 説明の必須 / 長さ
  assert.equal((await create(app, { name: "desc-empty", description: "  ", body: "b" })).status, 400);
  assert.equal((await create(app, { name: "desc-long", description: "x".repeat(1025), body: "b" })).status, 400);
  // 不正な body は 400
  assert.equal((await create(app, { name: "ok", body: "b" })).status, 400);
});

test("作成は固定の形式で公開し、公開後の発見一覧でも読める", async () => {
  const root = await makeWorkspace("skill-create-ok");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const created = await create(app, { name: "new-skill", description: "新しい説明", body: "本文1\n本文2" });
  assert.equal(created.status, 201);
  assert.equal(created.body.relativePath, ".agents/skills/new-skill/SKILL.md");
  assert.equal(
    await readFile(join(root, ".agents/skills/new-skill/SKILL.md"), "utf8"),
    '---\nname: "new-skill"\ndescription: "新しい説明"\n---\n本文1\n本文2',
  );
  const created_detail = await detail(app, ".agents/skills/new-skill/SKILL.md");
  assert.equal(created_detail.name, "new-skill");
  assert.equal(created_detail.description, "新しい説明");
  assert.equal(created_detail.body, "\n本文1\n本文2");
  // 置き場が無いワークスペースでも最初の 1 件を作れる
  const bare = mkdtempSync(join(tmpdir(), "pi-sbx-skill-bare-"));
  const bareApp = createSandboxService({ token: TOKEN, rootCwd: bare }).app;
  assert.equal((await create(bareApp, { name: "first", description: "d", body: "" })).status, 201);
  assert.equal(
    await readFile(join(bare, ".agents/skills/first/SKILL.md"), "utf8"),
    '---\nname: "first"\ndescription: "d"\n---\n',
  );
});

test(".gitignore で発見できない内容は読み取り専用として理由を返し、保存も拒否する", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-skill-ignored-"));
  await mkdir(join(root, ".agents/skills/hidden"), { recursive: true });
  await writeFile(join(root, ".agents/skills/.gitignore"), "hidden/\n", "utf8");
  await writeFile(
    join(root, ".agents/skills/hidden/SKILL.md"),
    '---\nname: hidden\ndescription: "d"\n---\nb\n',
    "utf8",
  );
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const body = await detail(app, ".agents/skills/hidden/SKILL.md");
  assert.equal(body.editable, false);
  assert.match(String(body.reason), /読み込めません/);
  const refused = await save(app, {
    relativePath: ".agents/skills/hidden/SKILL.md",
    fileVersion: body.fileVersion,
    description: "d",
    body: "changed",
  });
  assert.equal(refused.status, 400);
  assert.match(String(refused.body.error), /読み込めない/);
  assert.equal(
    await readFile(join(root, ".agents/skills/hidden/SKILL.md"), "utf8"),
    '---\nname: hidden\ndescription: "d"\n---\nb\n',
  );
  // 発見できないので新規作成もできない (同名の実体があるため 409)。保存の理由も読み込み不能を返す
  assert.equal((await create(app, { name: "hidden", description: "d", body: "b" })).status, 409);
});

test("削除確認は対象フォルダと付随ファイル・treeVersion を返し、取消では何も変更しない", async () => {
  const root = await makeWorkspace("skill-preview");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const before = await preview(app);
  assert.equal(before.name, "alpha");
  assert.equal(before.dir, ".agents/skills/alpha");
  assert.deepEqual(before.files, ["SKILL.md", "refs/", "refs/note.txt"]);
  assert.equal(before.entries, 3);
  assert.match(before.treeVersion, /^[0-9a-f]{64}$/);
  // 取消 (削除要求を出さない) は副作用なし
  assert.equal(
    await readFile(join(root, SKILL_PATH), "utf8"),
    '---\nname: alpha\ndescription: "元の説明"\n# コメント\nx-extra: 1\n---\n元の本文\n',
  );
  assert.deepEqual(await preview(app), before);
});

test("付随ファイルの変更後は古い treeVersion を拒否し、フォルダを消さない", async () => {
  const root = await makeWorkspace("skill-tree-version");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const before = await preview(app);
  await writeFile(join(root, ".agents/skills/alpha/refs/note.txt"), "changed", "utf8");
  assert.equal(await remove(app, SKILL_PATH, before.treeVersion), 409);
  assert.equal(await readFile(join(root, ".agents/skills/alpha/refs/note.txt"), "utf8"), "changed");
  // 付随ファイルの新規作成も version に載る
  const after = await preview(app);
  assert.notEqual(after.treeVersion, before.treeVersion);
  assert.deepEqual(after.files, ["SKILL.md", "refs/", "refs/note.txt"]);
});

test("フォルダ丸ごとの削除は配下の付随ファイルも消し、他スキルと置き場は残す", async () => {
  const root = await makeWorkspace("skill-delete");
  await mkdir(join(root, ".agents/skills/beta"), { recursive: true });
  await writeFile(join(root, ".agents/skills/beta/SKILL.md"), '---\nname: beta\ndescription: "b"\n---\nb\n', "utf8");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const before = await preview(app);
  assert.equal(await remove(app, SKILL_PATH, before.treeVersion), 204);
  await assert.rejects(() => readFile(join(root, SKILL_PATH)), /ENOENT/);
  await assert.rejects(() => readFile(join(root, ".agents/skills/alpha/refs/note.txt")), /ENOENT/);
  assert.equal(
    await readFile(join(root, ".agents/skills/beta/SKILL.md"), "utf8"),
    '---\nname: beta\ndescription: "b"\n---\nb\n',
  );
  // 削除済みの対象は 404、置き場直下の SKILL.md は削除できない
  assert.equal(await remove(app, SKILL_PATH, before.treeVersion), 404);
  await writeFile(join(root, ".agents/skills/SKILL.md"), '---\nname: root\ndescription: "r"\n---\nb\n', "utf8");
  const rootPreview = await app.request(
    `/v1/skills/file/delete-preview?relativePath=${encodeURIComponent(".agents/skills/SKILL.md")}`,
    { headers: authHeaders() },
  );
  assert.equal(rootPreview.status, 400);
  assert.equal(
    await readFile(join(root, ".agents/skills/SKILL.md"), "utf8"),
    '---\nname: root\ndescription: "r"\n---\nb\n',
  );
});

test("共通スキル置き場の外 (プロジェクト / 組み込み / root 外 / 別名) は変更できない", async () => {
  const root = await makeWorkspace("skill-boundary");
  await mkdir(join(root, "proj/.agents/skills/proj-skill"), { recursive: true });
  await writeFile(
    join(root, "proj/.agents/skills/proj-skill/SKILL.md"),
    '---\nname: p\ndescription: "p"\n---\nb\n',
    "utf8",
  );
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const paths = [
    "proj/.agents/skills/proj-skill/SKILL.md",
    ".u7agent/builtin-skills/skill-creator/SKILL.md",
    "../outside/SKILL.md",
    "/etc/hostname",
    ".agents/skills/../../etc/hostname",
    ".agents/skills/.hidden/SKILL.md",
  ];
  for (const path of paths) {
    const response = await app.request(`/v1/skills/file?relativePath=${encodeURIComponent(path)}`, {
      headers: authHeaders(),
    });
    assert.equal(response.status, 400, `detail ${path}`);
    const saved = await save(app, { relativePath: path, fileVersion: "0".repeat(64), description: "d", body: "b" });
    assert.equal(saved.status, 400, `save ${path}`);
    assert.equal(await remove(app, path, "0".repeat(64)), 400, `delete ${path}`);
  }
  assert.equal(
    await readFile(join(root, "proj/.agents/skills/proj-skill/SKILL.md"), "utf8"),
    '---\nname: p\ndescription: "p"\n---\nb\n',
  );
  // 既存ファイルの互換のため、長いディレクトリ名を一律には拒否しない (存在しなければ 404)。
  // 新規作成の名前の規則はサーバー側の SDK 検証が担うので、作成だけは 400 で止まる
  const longName = `.agents/skills/${"a".repeat(300)}/SKILL.md`;
  const longDetail = await app.request(`/v1/skills/file?relativePath=${encodeURIComponent(longName)}`, {
    headers: authHeaders(),
  });
  assert.equal(longDetail.status, 404);
  assert.equal((await create(app, { name: "a".repeat(300), description: "d", body: "b" })).status, 400);
  assert.equal(
    (await save(app, { relativePath: longName, fileVersion: "0".repeat(64), description: "d", body: "b" })).status,
    404,
  );
  // 既存の長いディレクトリ名でも、SDK が発見できれば編集できる (保存名の互換を狭めない)
  const longDir = "a".repeat(250);
  await mkdir(join(root, `.agents/skills/${longDir}`), { recursive: true });
  await writeFile(
    join(root, `.agents/skills/${longDir}/SKILL.md`),
    '---\nname: long-dir\ndescription: "d"\n---\nb\n',
    "utf8",
  );
  const longExisting = await detail(app, `.agents/skills/${longDir}/SKILL.md`);
  assert.equal(longExisting.name, "long-dir");
  assert.equal(longExisting.editable, true);
});

test(
  "置き場の外へ解決する symlink は読めず、外のファイルも変更しない",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const root = await makeWorkspace("skill-symlink-out");
    const outside = mkdtempSync(join(tmpdir(), "pi-sbx-skill-outside-"));
    const outsideFile = join(outside, "SKILL.md");
    await writeFile(outsideFile, '---\nname: outside\ndescription: "o"\n---\nsecret\n', "utf8");
    await mkdir(join(root, ".agents/skills/aliased"), { recursive: true });
    await symlink(outsideFile, join(root, ".agents/skills/aliased/SKILL.md"));
    const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
    const response = await app.request(
      `/v1/skills/file?relativePath=${encodeURIComponent(".agents/skills/aliased/SKILL.md")}`,
      { headers: authHeaders() },
    );
    assert.equal(response.status, 400);
    // SKILL.md が symlink の削除は専用フォルダを特定できないため拒否する (リンク先も残す)
    const previewResponse = await app.request(
      `/v1/skills/file/delete-preview?relativePath=${encodeURIComponent(".agents/skills/aliased/SKILL.md")}`,
      { headers: authHeaders() },
    );
    assert.equal(previewResponse.status, 400);
    assert.equal(await readFile(outsideFile, "utf8"), '---\nname: outside\ndescription: "o"\n---\nsecret\n');
  },
);

test("走査上限を超えるフォルダは削除確認と削除の両方で拒否する", async () => {
  const root = await makeWorkspace("skill-limits");
  await mkdir(join(root, ".agents/skills/alpha/many"), { recursive: true });
  for (let index = 0; index < 4; index += 1) {
    await writeFile(join(root, `.agents/skills/alpha/many/${index}.txt`), "x", "utf8");
  }
  const app = createSandboxService({ token: TOKEN, rootCwd: root, maxArchiveEntries: 3 }).app;
  const response = await app.request(`/v1/skills/file/delete-preview?relativePath=${encodeURIComponent(SKILL_PATH)}`, {
    headers: authHeaders(),
  });
  assert.equal(response.status, 413);
  assert.equal(await remove(app, SKILL_PATH, "0".repeat(64)), 413);
  assert.equal(
    await readFile(join(root, SKILL_PATH), "utf8"),
    '---\nname: alpha\ndescription: "元の説明"\n# コメント\nx-extra: 1\n---\n元の本文\n',
  );
});

test("読めない付随ファイルがあると削除確認と削除を拒否し、部分削除しない", async () => {
  const root = await makeWorkspace("skill-io-failure");
  await chmod(join(root, ".agents/skills/alpha/refs/note.txt"), 0o000);
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  try {
    const response = await app.request(
      `/v1/skills/file/delete-preview?relativePath=${encodeURIComponent(SKILL_PATH)}`,
      {
        headers: authHeaders(),
      },
    );
    assert.equal(response.status, 400);
    assert.equal(await remove(app, SKILL_PATH, "0".repeat(64)), 400);
    assert.equal(
      await readFile(join(root, SKILL_PATH), "utf8"),
      '---\nname: alpha\ndescription: "元の説明"\n# コメント\nx-extra: 1\n---\n元の本文\n',
    );
  } finally {
    await chmod(join(root, ".agents/skills/alpha/refs/note.txt"), 0o644);
  }
});

test("開始済みの abort (要求の signal) は変更前に拒否する", async () => {
  const root = await makeWorkspace("skill-abort");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const before = await detail(app);
  const controller = new AbortController();
  controller.abort();
  const response = await app.request("/v1/skills/file", {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ relativePath: SKILL_PATH, fileVersion: before.fileVersion, description: "x", body: "y" }),
    signal: controller.signal,
  });
  assert.equal(response.status, 400);
  assert.equal(
    await readFile(join(root, SKILL_PATH), "utf8"),
    '---\nname: alpha\ndescription: "元の説明"\n# コメント\nx-extra: 1\n---\n元の本文\n',
  );
  const removed = await app.request(`/v1/skills/file?relativePath=${encodeURIComponent(SKILL_PATH)}&treeVersion=x`, {
    method: "DELETE",
    headers: authHeaders(),
    signal: controller.signal,
  });
  assert.equal(removed.status, 400);
  assert.equal(
    await readFile(join(root, SKILL_PATH), "utf8"),
    '---\nname: alpha\ndescription: "元の説明"\n# コメント\nx-extra: 1\n---\n元の本文\n',
  );
});

test("GUI 保存と SDK edit が競合しても、片方の内容だけで整合する", async () => {
  const root = await makeWorkspace("skill-race");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const before = await detail(app);
  const [saveResult, editResult] = await Promise.all([
    save(app, {
      relativePath: SKILL_PATH,
      fileVersion: before.fileVersion,
      description: "GUI の説明",
      body: before.body,
    }),
    executeTool(app, "edit", { path: SKILL_PATH, edits: [{ oldText: "元の本文", newText: "SDK の本文" }] }),
  ]);
  assert.equal(editResult.error, undefined);
  const text = await readFile(join(root, SKILL_PATH), "utf8");
  if (saveResult.status === 200) {
    // GUI 保存が先: SDK の edit は GUI 保存後の内容へ当たる
    assert.equal(text, '---\nname: alpha\ndescription: "GUI の説明"\n# コメント\nx-extra: 1\n---\nSDK の本文\n');
  } else {
    // SDK の edit が先: GUI 保存は版の不一致で止まり、内容は SDK の edit だけになる
    assert.equal(saveResult.status, 409);
    assert.equal(text, '---\nname: alpha\ndescription: "元の説明"\n# コメント\nx-extra: 1\n---\nSDK の本文\n');
  }
});

test("同じ版で同時に保存しても、書き込めるのは 1 つだけ", async () => {
  const root = await makeWorkspace("skill-save-race");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const before = await detail(app);
  const results = await Promise.all([
    save(app, { relativePath: SKILL_PATH, fileVersion: before.fileVersion, description: "A", body: before.body }),
    save(app, { relativePath: SKILL_PATH, fileVersion: before.fileVersion, description: "B", body: before.body }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const text = await readFile(join(root, SKILL_PATH), "utf8");
  assert.match(text, /description: "(A|B)"/);
});

test("フォルダの rename / move / 削除の後は、旧パスを再作成せず 404 / 409 で止まる", async () => {
  const root = await makeWorkspace("skill-folder-moved");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const before = await detail(app);

  const renamed = await app.request("/v1/files/rename", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ path: ".agents/skills/alpha", name: "renamed" }),
  });
  assert.equal(renamed.status, 200);
  const staleSave = await save(app, {
    relativePath: SKILL_PATH,
    fileVersion: before.fileVersion,
    description: "x",
    body: before.body,
  });
  assert.equal(staleSave.status, 404);
  await assert.rejects(() => readFile(join(root, SKILL_PATH)), /ENOENT/);
  assert.equal(
    await readFile(join(root, ".agents/skills/renamed/SKILL.md"), "utf8"),
    '---\nname: alpha\ndescription: "元の説明"\n# コメント\nx-extra: 1\n---\n元の本文\n',
  );

  // 移動先でも同じ (旧パスは作られない)
  const moved = await app.request("/v1/files/move", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ from: ".agents/skills/renamed", to: ".agents/skills/moved" }),
  });
  assert.equal(moved.status, 200);
  assert.equal(
    (
      await save(app, {
        relativePath: ".agents/skills/renamed/SKILL.md",
        fileVersion: before.fileVersion,
        description: "x",
        body: before.body,
      })
    ).status,
    404,
  );
  await assert.rejects(() => readFile(join(root, ".agents/skills/renamed/SKILL.md")), /ENOENT/);

  // 削除後も同じ
  const deleteDir = await app.request(`/v1/dirs?path=${encodeURIComponent(".agents/skills/moved")}&recursive=true`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  assert.equal(deleteDir.status, 204);
  assert.equal(
    (
      await save(app, {
        relativePath: ".agents/skills/moved/SKILL.md",
        fileVersion: before.fileVersion,
        description: "x",
        body: before.body,
      })
    ).status,
    404,
  );
  await assert.rejects(() => readFile(join(root, ".agents/skills/moved/SKILL.md")), /ENOENT/);
});

test("付随ファイルの更新は treeVersion に載り、削除の取り直しを要求する", async () => {
  const root = await makeWorkspace("skill-attached");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const before = await preview(app);
  // SDK の write で付随ファイルを追加する (GUI CRUD と同じ共通 gate に参加する経路)
  const written = await executeTool(app, "write", {
    path: ".agents/skills/alpha/refs/added.txt",
    content: "added",
  });
  assert.equal(written.error, undefined);
  const after = await preview(app);
  assert.notEqual(after.treeVersion, before.treeVersion);
  assert.equal(await remove(app, SKILL_PATH, before.treeVersion), 409);
  assert.equal(await remove(app, SKILL_PATH, after.treeVersion), 204);
  await assert.rejects(() => readFile(join(root, ".agents/skills/alpha/refs/added.txt")), /ENOENT/);
});

test("保存の上限を超えるファイルは閲覧だけを許し、保存できない理由を返す", async () => {
  const root = await makeWorkspace("skill-large");
  await writeFile(
    join(root, SKILL_PATH),
    `---\nname: alpha\ndescription: "d"\n---\n${"x".repeat(70 * 1024)}\n`,
    "utf8",
  );
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const body = await detail(app);
  assert.equal(body.editable, false);
  assert.match(String(body.reason), /64 KiB/);
  // 本文は切り詰めずそのまま返す (読むだけはできる)
  assert.equal(body.body.length, 70 * 1024 + 2);
  const createLarge = await create(app, { name: "another", description: "d", body: "b" });
  assert.equal(createLarge.status, 201);
});

test("要求の上限を超える body は 413 で拒否し、本文を切り詰めない", async () => {
  const root = await makeWorkspace("skill-body-limit");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  const before = await detail(app);
  const response = await app.request("/v1/skills/file", {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({
      relativePath: SKILL_PATH,
      fileVersion: before.fileVersion,
      description: "d",
      body: "x".repeat(9 * 1024 * 1024),
    }),
  });
  assert.equal(response.status, 413);
  assert.equal(
    await readFile(join(root, SKILL_PATH), "utf8"),
    '---\nname: alpha\ndescription: "元の説明"\n# コメント\nx-extra: 1\n---\n元の本文\n',
  );
});

test("保存に失敗しても本文やその他の値を部分適用しない (staged 検証の失敗)", async () => {
  const root = await makeWorkspace("skill-stage-failure");
  const app = createSandboxService({ token: TOKEN, rootCwd: root }).app;
  // 既存の name は規約外 (大文字) だが、変更した説明が空になる保存は SDK 検証で拒否される
  const text = '---\nname: Bad Name\ndescription: "元の説明"\n---\n元の本文\n';
  await writeFile(join(root, SKILL_PATH), text, "utf8");
  const relisted = await detail(app);
  assert.equal(relisted.editable, true);
  const failed = await save(app, {
    relativePath: SKILL_PATH,
    fileVersion: relisted.fileVersion,
    description: "   ",
    body: "changed",
  });
  assert.equal(failed.status, 400);
  assert.equal(await readFile(join(root, SKILL_PATH), "utf8"), text);
});
