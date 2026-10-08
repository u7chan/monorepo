// 添付ファイルの純関数 (lib/attachments.ts)。注記の形式は server/src/attachments.ts と対で、
// ここではサーバーが実際に組み立てた形の文字列をパースできることを固定する。

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  attachmentFetchPath,
  attachmentRejection,
  attachmentsForSend,
  attachmentsForSession,
  formatBytes,
  isAudioName,
  isImageName,
  splitAttachedFiles,
  type Attachment,
} from "../src/lib/attachments";

/** server/src/attachments.ts の composePrompt が作る形 (モデルへは絶対パスで知らせる) */
const UPLOADS_DIR = "/workspace/.u7agent/uploads/a1b2c3d4e5";
const PROMPT = [
  "これを見て",
  "",
  "<attached_files>",
  `- ${UPLOADS_DIR}/photo.png`,
  `- ${UPLOADS_DIR}/report.pdf`,
  "</attached_files>",
].join("\n");

test("splitAttachedFiles splits the trailing note from the body", () => {
  assert.deepEqual(splitAttachedFiles(PROMPT), {
    text: "これを見て",
    files: [`${UPLOADS_DIR}/photo.png`, `${UPLOADS_DIR}/report.pdf`],
  });
  // 注記が無い本文はそのまま
  assert.deepEqual(splitAttachedFiles("ただの本文"), { text: "ただの本文", files: [] });
  // 添付だけの送信 (本文が空) は空文字に戻る
  assert.deepEqual(splitAttachedFiles(PROMPT.slice("これを見て\n\n".length)), {
    text: "",
    files: [`${UPLOADS_DIR}/photo.png`, `${UPLOADS_DIR}/report.pdf`],
  });
  // 本文に同じタグが入っていても、末尾の注記だけを切り離す
  const tricky = [
    "本文に <attached_files> を含む",
    "",
    "<attached_files>",
    `- ${UPLOADS_DIR}/a.png`,
    "</attached_files>",
  ].join("\n");
  assert.deepEqual(splitAttachedFiles(tricky).text, "本文に <attached_files> を含む");
  // ファイル行以外は無視する
  assert.deepEqual(splitAttachedFiles(`<attached_files>\n補足\n- ${UPLOADS_DIR}/a.png\n</attached_files>`).files, [
    `${UPLOADS_DIR}/a.png`,
  ]);
});

test("attachmentFetchPath turns note absolute paths into the root-relative form", () => {
  const path = `${UPLOADS_DIR}/photo.png`;
  assert.equal(attachmentFetchPath("/workspace", path), ".u7agent/uploads/a1b2c3d4e5/photo.png");
  // アップロード直後のチップは既に root 相対
  assert.equal(
    attachmentFetchPath("/workspace", ".u7agent/uploads/a1b2c3d4e5/photo.png"),
    ".u7agent/uploads/a1b2c3d4e5/photo.png",
  );
  // root が未取得 ("") でもそのまま返す (サムネイルは 404 になるだけで表示は壊さない)
  assert.equal(attachmentFetchPath("", path), path);
  // 末尾スラッシュと Windows 区切りの root も剥がす
  assert.equal(
    attachmentFetchPath("C:\\ws\\", "C:/ws/.u7agent/uploads/a1b2c3d4e5/photo.png"),
    ".u7agent/uploads/a1b2c3d4e5/photo.png",
  );
  // root 配下でない絶対パスはそのまま (誤って別パスへ読み替えない)
  assert.equal(attachmentFetchPath("/other", path), path);
});

test("isImageName only accepts the raw-servable extensions", () => {
  for (const name of ["a.png", "photo.JPG", "x.jpeg", "x.gif", "x.webp", "x.avif", "x.bmp", "favicon.ico"]) {
    assert.equal(isImageName(name), true, name);
  }
  for (const name of ["a.svg", "a.html", "a.txt", "noext", ".env", "uploads/.png", "a.png.exe"]) {
    assert.equal(isImageName(name), false, name);
  }
});

test("isAudioName accepts only the audio extensions and keeps them apart from images", () => {
  for (const name of ["a.mp3", "song.M4A", "voice.ogg", "voice.oga", "beat.wav", "master.flac"]) {
    assert.equal(isAudioName(name), true, name);
  }
  for (const name of ["a.png", "photo.JPG", "a.mp4", "a.webm", "noext", ".mp3", "uploads/.ogg", "a.mp3.exe"]) {
    assert.equal(isAudioName(name), false, name);
  }
  // 添付アップロードの制限は画像の allowlist のままで、音声を足しても広がらない
  assert.equal(isImageName("a.mp3"), false);
  assert.equal(isAudioName("a.png"), false);
});

test("formatBytes shows a compact size for chips", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(MAX_ATTACHMENT_BYTES), "100.0 MB");
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), "3.0 GB");
  assert.equal(formatBytes(Number.NaN), "");
});

test("attachmentsForSession keeps only the chips of the current session", () => {
  const chip = (id: string, sessionId: string): Attachment => ({
    id,
    sessionId,
    name: `${id}.png`,
    size: 1,
    status: "done",
    path: `.u7agent/uploads/a1b2c3d4e5/${id}.png`,
  });
  const chips = [chip("a", "s-1"), chip("b", ""), chip("c", "s-2")];

  // 切替直後 (effect の削除前) に前のセッションのチップを描かない
  assert.deepEqual(
    attachmentsForSession(chips, "s-2").map((item) => item.id),
    ["c"],
  );
  assert.deepEqual(
    attachmentsForSession(chips, "").map((item) => item.id),
    ["b"],
    "未作成チャットのチップは残す",
  );
  assert.deepEqual(attachmentsForSession(chips, "s-3"), []);
  assert.deepEqual(attachmentsForSession([], "s-1"), []);
});

test("attachmentRejection reports the reason to keep as an error chip", () => {
  assert.equal(attachmentRejection({ name: "a.png", size: 1024 }, 0), undefined);
  assert.equal(attachmentRejection({ name: "a.png", size: 1024 }, MAX_ATTACHMENTS - 1), undefined);
  assert.match(attachmentRejection({ name: "a.png", size: 1024 }, MAX_ATTACHMENTS) ?? "", /最大 10 件まで/);
  assert.match(attachmentRejection({ name: "a.bin", size: MAX_ATTACHMENT_BYTES + 1 }, 0) ?? "", /100 MiB を超える/);
  // 上限ちょうどは通す
  assert.equal(attachmentRejection({ name: "a.bin", size: MAX_ATTACHMENT_BYTES }, 0), undefined);
});

test("attachmentsForSend carries and consumes the chips of the current session", () => {
  const chip = (id: string, extra: Partial<Attachment> = {}): Attachment => ({
    id,
    sessionId: "s-1",
    name: `${id}.png`,
    size: 1,
    status: "done",
    path: `.u7agent/uploads/s-1/${id}.png`,
    ...extra,
  });
  const chips = [
    chip("a"),
    chip("b", { status: "uploading", path: undefined }),
    chip("c", { sessionId: "s-2" }),
    chip("d", { status: "error", path: undefined }),
  ];

  const normal = attachmentsForSend(chips, "s-1", true);
  // アップロード中 / 失敗のチップは pending に残る (呼び出し側がこの集合で送信を止める)
  assert.deepEqual(
    normal.pending.map((item) => item.id),
    ["a", "b", "d"],
  );
  assert.deepEqual(normal.paths, [".u7agent/uploads/s-1/a.png"], "パスを持つチップだけを送る");
  assert.deepEqual(normal.sentIds, ["a", "b", "d"], "送れたら現在のセッションのチップを消費する");
  assert.deepEqual(attachmentsForSend(chips, "s-3", true).pending, [], "別セッションのチップは載せない");
});

test("attachmentsForSend keeps the chips out of a send that takes no attachments", () => {
  const chips: Attachment[] = [
    { id: "a", sessionId: "s-1", name: "a.png", size: 1, status: "done", path: ".u7agent/uploads/s-1/a.png" },
    { id: "b", sessionId: "s-1", name: "b.png", size: 1, status: "uploading" },
  ];

  // 失敗の再実行は固定文言だけを送る。アップロード完了を待たず、送信後もチップを消さない
  const retry = attachmentsForSend(chips, "s-1", false);
  assert.deepEqual(retry, { pending: [], paths: [], sentIds: [] });
  assert.deepEqual(attachmentsForSend([], "s-1", false), { pending: [], paths: [], sentIds: [] });
});
