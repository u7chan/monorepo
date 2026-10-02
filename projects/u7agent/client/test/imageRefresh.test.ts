import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useImageVersion } from "../src/hooks/useImageVersion";
import { MarkdownImageProvider } from "../src/components/markdown/MarkdownImageRefs";
import { MarkdownView } from "../src/components/markdown/MarkdownView";
import { filePreviewStore } from "../src/lib/filePreviewState";

globalThis.location ??= { origin: "http://localhost:3000", hostname: "localhost" } as Location;
const { fileRawUrl } = await import("../src/api");
const { useMarkdownImageRawUrl } = await import("../src/hooks/useMarkdownImageRawUrl");
const { FileBrowser } = await import("../src/components/FileBrowser");

const root = "image-refresh-test";
const path = `${root}/cafe.png`;

function imageUrl(html: string): string {
  const src = html.match(/<img\b[^>]*\bsrc="([^"]+)"/)?.[1];
  assert.ok(src, html);
  const url = new URL(src.replaceAll("&amp;", "&"));
  assert.equal(url.searchParams.get("path"), path);
  assert.ok(url.searchParams.has("v"));
  return url.toString();
}

test("同一 mount の再描画では安定し、run 終了・手動更新は過去のどの面の URL とも衝突しない", () => {
  const tokens = [
    { run: 1, reload: 1 },
    { run: 1, reload: 1 },
    { run: 2, reload: 2 },
    { run: 2, reload: 2 },
    { run: 2, reload: 3 },
    { run: 2, reload: 3 },
  ];
  const frames: { chat: string; preview: string; rawUrl: (path: string) => string }[] = [];
  // SSR の再描画を使い、同じ hook state を保ったまま入力の遷移を再生する。版の採番は実フックに任せる。
  function Probe() {
    const [step, setStep] = useState(0);
    const rawUrl = useMarkdownImageRawUrl(tokens[step].run);
    const previewVersion = useImageVersion(tokens[step].reload);
    frames.push({ chat: rawUrl(path), preview: fileRawUrl(path, previewVersion), rawUrl });
    if (step < tokens.length - 1) setStep(step + 1);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(frames.length, tokens.length);
  const seen = new Set<string>();
  frames.forEach((frame, index) => {
    const previous = frames[index - 1];
    for (const surface of ["chat", "preview"] as const) {
      const token = surface === "chat" ? "run" : "reload";
      if (previous && tokens[index][token] === tokens[index - 1][token]) {
        assert.equal(frame[surface], previous[surface], `${surface}: 通常の再描画で URL を変えない`);
      } else {
        assert.ok(!seen.has(frame[surface]), `${surface}: 過去の画像 URL を再利用しない`);
        seen.add(frame[surface]);
      }
    }
    if (previous && tokens[index].run === tokens[index - 1].run) assert.equal(frame.rawUrl, previous.rawUrl);
  });
});

test("実 Markdown と FileBrowser の配線: run 1 → パネル → run 2 → 手動更新 → 再 mount で古い URL に戻らない", () => {
  filePreviewStore.write(root, { paths: ["cafe.png"], active: "cafe.png", modes: {}, dirs: [] });
  function Chat({ runEndSeq }: { runEndSeq: number }) {
    const rawUrl = useMarkdownImageRawUrl(runEndSeq);
    return createElement(MarkdownImageProvider, {
      rootCwd: "/workspace",
      cwd: root,
      rawUrl,
      children: createElement(MarkdownView, { text: "![cafe](cafe.png)" }),
    });
  }
  const chat = (runEndSeq: number) => imageUrl(renderToStaticMarkup(createElement(Chat, { runEndSeq })));
  const panel = (reloadToken: number) =>
    imageUrl(renderToStaticMarkup(createElement(FileBrowser, { root, reloadToken, excludeNames: [] })));
  const urls = [chat(1), panel(1), chat(2), panel(2), panel(3), panel(2), panel(3)];
  assert.equal(new Set(urls).size, urls.length, "面の切替や mount 時の token リセットでも URL を再利用しない");
  const versions = urls.map((url) => Number(new URL(url).searchParams.get("v")));
  versions.forEach((version, index) => {
    if (index > 0) assert.ok(version > versions[index - 1], "mount を跨いで版が戻らない");
  });
  assert.equal(new URL(fileRawUrl(path)).searchParams.has("v"), false, "不変な添付用 URL は版を付けない");
});
