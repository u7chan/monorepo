// listen せず app.request() で検証する。SDK の loadSkillsFromDir と実ファイルシステムだけを使い、実 LLM API は呼ばない。
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import test from "node:test";
import { createSandboxService } from "../src/sandbox/service";
import type { SandboxSkillEntry, SandboxSkillsResponse } from "../src/sandbox/protocol";

const TOKEN = "test-sandbox-token-0123456789abcdef";
// Windows では開発者モードが無いと symlink を作れない
const HAS_SYMLINK = (() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sbx-skills-symlink-check-"));
  try {
    symlinkSync(dir, join(dir, "link"));
    return true;
  } catch {
    return false;
  }
})();
const SYMLINK_SKIP_REASON = "symlinks are not available on this platform";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

/** SKILL.md を 1 つ作る。name / description の指定は CLI 引数なしで済むよう固定の雛形にする。 */
async function writeSkill(root: string, relativeDir: string, frontmatter: string): Promise<void> {
  const dir = join(root, relativeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\nbody\n`, "utf8");
}

async function listSkills(
  app: ReturnType<typeof createSandboxService>["app"],
  dir: string,
): Promise<{ status: number; skills: SandboxSkillEntry[]; error?: string }> {
  const response = await app.request(`/v1/skills?dir=${encodeURIComponent(dir)}`, { headers: authHeaders() });
  const body = (await response.json()) as SandboxSkillsResponse & { error?: string };
  return { status: response.status, skills: body.skills ?? [], ...(body.error ? { error: body.error } : {}) };
}

test("discovers SKILL.md files under .agents/skills and skips non-skill entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-skills-basic-"));
  const skillsDir = ".agents/skills";
  await writeSkill(root, `${skillsDir}/alpha`, "name: alpha\ndescription: Alpha skill");
  await writeSkill(
    root,
    `${skillsDir}/group/beta`,
    "name: beta\ndescription: Beta skill\ndisable-model-invocation: true",
  );
  // 直下の非 SKILL.md・hidden・node_modules・ignore 対象は SDK の走査規則で落ちる (SKILL.md だけを返す)
  await mkdir(join(root, skillsDir), { recursive: true });
  await writeFile(join(root, skillsDir, "note.md"), "---\nname: note\ndescription: Note\n---\nbody\n", "utf8");
  await writeSkill(root, `${skillsDir}/.hidden`, "name: hidden\ndescription: Hidden");
  await writeSkill(root, `${skillsDir}/node_modules/dep`, "name: dep\ndescription: Dependency");
  await writeSkill(root, `${skillsDir}/ignored`, "name: ignored\ndescription: Ignored");
  await writeFile(join(root, skillsDir, ".gitignore"), "ignored/\n", "utf8");
  // frontmatter 不正 (YAML エラー) と description 無しは SDK が warn して落とす
  await writeSkill(root, `${skillsDir}/broken`, "name: [unclosed");
  await writeSkill(root, `${skillsDir}/nodesc`, "name: nodesc");

  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const result = await listSkills(service.app, skillsDir);
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.skills.map((skill) => [skill.name, skill.description, skill.disableModelInvocation]),
    [
      ["alpha", "Alpha skill", false],
      ["beta", "Beta skill", true],
    ],
  );
  assert.equal(result.skills[0].path, await realpath(join(root, skillsDir, "alpha/SKILL.md")));
});

test("validates dir like the file listing endpoints", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-skills-paths-"));
  await mkdir(join(root, ".agents/skills"), { recursive: true });
  await writeFile(join(root, "file.txt"), "not a directory", "utf8");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  assert.equal((await listSkills(service.app, "../outside")).status, 400);
  assert.equal((await listSkills(service.app, ".agents/missing")).status, 404);
  assert.equal((await listSkills(service.app, "file.txt")).status, 400);
  // 置き場が無いだけのディレクトリは「スキル 0 件」ではなく 404 (BFF が空として扱う)
  assert.equal((await listSkills(service.app, "")).status, 200);
  assert.equal((await listSkills(service.app, "")).skills.length, 0);
});

test("drops symlinks that resolve outside the root", { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-skills-outside-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-sbx-skills-outside-target-"));
  const skillsDir = join(root, ".agents/skills");
  await writeSkill(root, ".agents/skills/inside", "name: inside\ndescription: Inside skill");

  // SKILL.md の symlink と、子ディレクトリの symlink の両方で root 外へ解決する
  await writeFile(join(outside, "SKILL.md"), "---\nname: linked\ndescription: Linked skill\n---\nbody\n", "utf8");
  await mkdir(join(skillsDir, "linked-file"), { recursive: true });
  await symlink(join(outside, "SKILL.md"), join(skillsDir, "linked-file/SKILL.md"));
  await symlink(outside, join(skillsDir, "linked-dir"));

  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const result = await listSkills(service.app, ".agents/skills");
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.skills.map((skill) => skill.name),
    ["inside"],
  );
});

test("dedupes symlink aliases and cycles inside the root", { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-skills-cycle-"));
  const skillsDir = join(root, ".agents/skills");
  await writeSkill(root, ".agents/skills/real", "name: real\ndescription: Real skill");
  // 同じ実体への alias と、root 内で閉じた循環リンク (SDK は SKILL.md を見つけるまで辿る)
  await symlink(join(skillsDir, "real"), join(skillsDir, "alias"));
  await symlink(skillsDir, join(skillsDir, "loop"));

  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const result = await listSkills(service.app, ".agents/skills");
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.skills.map((skill) => skill.name),
    ["real"],
  );
  assert.equal(result.skills[0].path, await realpath(join(skillsDir, "real/SKILL.md")));
});

test(
  "cuts off branching symlink cycles instead of blocking the sandbox",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-skills-pathological-"));
    const skillsDir = join(root, ".agents/skills");
    await writeSkill(root, ".agents/skills/real", "name: real\ndescription: Real skill");
    // 自己参照する symlink が 2 本あると SDK の走査は指数的に増える (期限で打ち切る)
    await symlink(skillsDir, join(skillsDir, "loop-a"));
    await symlink(skillsDir, join(skillsDir, "loop-b"));

    const service = createSandboxService({ token: TOKEN, rootCwd: root, skillsScanTimeoutMs: 300 });
    const started = Date.now();
    const scan = listSkills(service.app, ".agents/skills");
    // 走査は別スレッドなので、走査中でも他のリクエストは処理される (プロセスを塞がない)
    const health = await service.app.request("/healthz");
    assert.equal(health.status, 200);

    const result = await scan;
    assert.equal(result.status, 504);
    assert.match(result.error ?? "", /スキルの走査が期限/);
    // 期限 (300ms) と worker の起動分だけで返る (指数的増殖を main thread で待たない)
    assert.ok(Date.now() - started < 5000, `scan took ${Date.now() - started}ms`);

    // worker を捨てた後も次の要求は新しい worker で走る (走査が恒久的に壊れない)
    await rm(join(skillsDir, "loop-a"));
    await rm(join(skillsDir, "loop-b"));
    const recovered = await listSkills(service.app, ".agents/skills");
    assert.equal(recovered.status, 200);
    assert.deepEqual(
      recovered.skills.map((skill) => skill.name),
      ["real"],
    );
  },
);

test("requires the sandbox token", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-skills-auth-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const response = await service.app.request("/v1/skills?dir=.agents/skills");
  assert.equal(response.status, 401);
});
