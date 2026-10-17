// 共通スキル (`.agents/skills`) の API 要求と応答の写像を、fetch を差し替えて固定する。
// hc のクライアントはパスと query を組み立てるだけなので、method / URL / body をそのまま検査する。
import assert from "node:assert/strict";
import test from "node:test";

globalThis.location ??= { origin: "http://localhost" } as Location;
const {
  ApiError,
  applySkillsImport,
  createFileSkill,
  deleteFileSkill,
  getFileSkillDeletePreview,
  getFileSkillDetail,
  getSkillsExportCheck,
  planSkillsImport,
  saveFileSkill,
  skillsExportUrl,
} = await import("../src/api");

const DETAIL = {
  name: "alpha",
  description: "説明",
  body: "\n本文\n",
  relativePath: ".agents/skills/alpha/SKILL.md",
  fileVersion: "a".repeat(64),
  editable: true,
};

test("編集内容の取得は relativePath を query で送り、応答をそのまま返す", async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json(DETAIL);
  });
  assert.deepEqual(await getFileSkillDetail(DETAIL.relativePath), DETAIL);
  const url = new URL(requests[0].url);
  assert.equal(`${requests[0].method} ${url.pathname}`, "GET /api/skills/files/detail");
  assert.equal(url.searchParams.get("relativePath"), DETAIL.relativePath);
});

test("作成と保存は JSON body を送り、保存は name を組み立てない", async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({ relativePath: DETAIL.relativePath, fileVersion: "b".repeat(64) }, { status: 201 });
  });
  assert.deepEqual(await createFileSkill({ name: "new-skill", description: "d", body: "b" }), {
    relativePath: DETAIL.relativePath,
    fileVersion: "b".repeat(64),
  });
  assert.deepEqual(
    await saveFileSkill({
      relativePath: DETAIL.relativePath,
      fileVersion: DETAIL.fileVersion,
      description: "新しい説明",
      body: "\n新しい本文\n",
    }),
    { relativePath: DETAIL.relativePath, fileVersion: "b".repeat(64) },
  );
  const urls = requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
  assert.deepEqual(urls, ["POST /api/skills/files", "PATCH /api/skills/files"]);
  assert.deepEqual(await requests[0].json(), { name: "new-skill", description: "d", body: "b" });
  assert.deepEqual(await requests[1].json(), {
    relativePath: DETAIL.relativePath,
    fileVersion: DETAIL.fileVersion,
    description: "新しい説明",
    body: "\n新しい本文\n",
  });
});

test("削除確認と削除は query だけで送り、削除の応答本文は読まない", async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({
      relativePath: DETAIL.relativePath,
      name: "alpha",
      dir: ".agents/skills/alpha",
      treeVersion: "c".repeat(64),
      entries: 2,
      bytes: 10,
      files: ["SKILL.md", "refs/note.txt"],
    });
  });
  const preview = await getFileSkillDeletePreview(DETAIL.relativePath);
  assert.equal(preview.dir, ".agents/skills/alpha");
  assert.deepEqual(preview.files, ["SKILL.md", "refs/note.txt"]);
  await deleteFileSkill(preview.relativePath, preview.treeVersion);
  const previewUrl = new URL(requests[0].url);
  assert.equal(`${requests[0].method} ${previewUrl.pathname}`, "GET /api/skills/files/delete-preview");
  assert.equal(previewUrl.searchParams.get("relativePath"), DETAIL.relativePath);
  const deleteUrl = new URL(requests[1].url);
  assert.equal(`${requests[1].method} ${deleteUrl.pathname}`, "DELETE /api/skills/files");
  assert.equal(deleteUrl.searchParams.get("relativePath"), DETAIL.relativePath);
  assert.equal(deleteUrl.searchParams.get("treeVersion"), preview.treeVersion);
});

test("競合 (409) と上限 (413) は status と文言を保って reject する", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "スキルが他の変更と競合しました。再読み込みしてから保存してください" }, { status: 409 }),
  );
  const conflict = await saveFileSkill({
    relativePath: DETAIL.relativePath,
    fileVersion: DETAIL.fileVersion,
    description: "d",
    body: "b",
  }).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(conflict instanceof ApiError);
  assert.equal(conflict.status, 409);
  assert.match(conflict.message, /競合/);

  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Request body is too large" }, { status: 413 }),
  );
  const tooLarge = await createFileSkill({ name: "big", description: "d", body: "x" }).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(tooLarge instanceof ApiError);
  assert.equal(tooLarge.status, 413);
  assert.match(tooLarge.message, /too large/i);
});

test("持ち出しの check は export の見積りを返し、保存の URL は export を指す", async (t) => {
  // 検査するのは、GET の path と応答の写像、そして本文を fetch せずに組み立てる保存の URL (<a download> の href)
  const check = { kind: "archive", name: "skills.zip", bytes: 2048, entries: 12, skipped: [] };
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json(check);
  });
  assert.deepEqual(await getSkillsExportCheck(), check);
  assert.equal(`${requests[0].method} ${new URL(requests[0].url).pathname}`, "GET /api/skills/files/export/check");
  assert.equal(new URL(skillsExportUrl()).pathname, "/api/skills/files/export");
});

test("持ち出しの check は 404 と 413 を理由を保って reject する", async (t) => {
  // 検査するのは、`.agents/skills` が無い 404 と上限超過の 413 が、どちらも HTTP status と理由を
  // 保って ApiError になること (画面はこの 2 つを区別せず、そのまま注記へ出す)
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: ".agents/skills が見つかりません" }, { status: 404 }),
  );
  const missing = await getSkillsExportCheck().then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(missing instanceof ApiError);
  assert.equal(missing.status, 404);
  assert.equal(missing.message, ".agents/skills が見つかりません");

  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Export archive is too large" }, { status: 413 }),
  );
  const tooLarge = await getSkillsExportCheck().then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(tooLarge instanceof ApiError);
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.message, "Export archive is too large");
});

test("取り込みの plan と apply は同じ ZIP を raw で送り、replace を繰り返す", async (t) => {
  // 検査するのは、query (dryRun / replace の繰り返し) と、plan と apply が同じバイト列を送ること
  const plan = { skills: [{ name: "alpha", status: "new" }], entries: 3, bytes: 128 };
  const applied = { applied: [], skipped: [], entries: 3, bytes: 128 };
  const requests: Request[] = [];
  const bodies: number[][] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    bodies.push([...new Uint8Array(await request.arrayBuffer())]);
    return Response.json(new URL(request.url).searchParams.get("dryRun") === "true" ? plan : applied);
  });
  const zip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "skills.zip");
  assert.deepEqual(await planSkillsImport(zip), plan);
  assert.deepEqual(await applySkillsImport(zip, ["gamma", "delta"]), applied);

  assert.deepEqual(
    requests.map((request) => `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`),
    ["POST /api/skills/files/import?dryRun=true", "POST /api/skills/files/import?replace=gamma&replace=delta"],
  );
  // plan と apply は同じ File をそのまま送る (サーバーは受信した ZIP とその時点の状態で判定する)
  assert.deepEqual(bodies, [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x03, 0x04],
  ]);
});

test("取り込みの plan は 400 と 413 を理由を保って reject する", async (t) => {
  // 検査するのは、ZIP でない / 構造不正の 400 と、上限超過の 413 が、どちらも HTTP status と理由を
  // 保って ApiError になること (画面はこの 2 つを区別せず、そのまま注記へ出す)
  const zip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "skills.zip");
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "アーカイブが ZIP ではありません" }, { status: 400 }),
  );
  const invalid = await planSkillsImport(zip).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(invalid instanceof ApiError);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.message, "アーカイブが ZIP ではありません");

  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Import archive is too large" }, { status: 413 }),
  );
  const tooLarge = await planSkillsImport(zip).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(tooLarge instanceof ApiError);
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.message, "Import archive is too large");
});
