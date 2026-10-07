async function checkChatScroll(page) {
  // 実 LLM の速度や認証状態には依存させない。
  const sessionId = "scroll-check";
  const generation = "scroll-check-generation";
  const now = Date.now();
  const payload = {
    sessionId,
    piSessionId: sessionId,
    cwd: "",
    eventGeneration: generation,
    model: "mock/mock",
    supportsThinking: false,
    availableThinkingLevels: ["off"],
    status: "idle",
    title: "Scroll check",
    createdAt: now,
    lastUsedAt: now,
    serverNow: now,
    queueDepth: 0,
    lastSeq: 0,
    run: null,
    messages: [],
    compactions: [],
    notify: false,
  };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/health", (route) =>
    json(route, {
      ready: true,
      model: "mock/mock",
      availableModels: ["mock/mock"],
      modelOptions: [{ provider: "mock", id: "mock", name: "Mock", supportsThinking: false, thinkingLevels: ["off"] }],
      defaultThinkingLevel: "off",
    }),
  );
  await page.route("**/api/sessions", (route) =>
    route.request().method() === "POST" ? json(route, payload, 201) : json(route, { sessions: [] }),
  );
  await page.route(`**/api/sessions/${sessionId}`, (route) => json(route, payload));
  await page.route(`**/api/sessions/${sessionId}/history**`, (route) =>
    json(route, {
      sessionId,
      items: [],
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
      activeContextStartId: null,
      messageCount: 0,
      summarizedMessageCount: 0,
    }),
  );
  await page.addInitScript(() => {
    const probe = (window.__scrollCheck = { samples: [], sampling: true, done: false, source: null });
    window.EventSource = class extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readyState = 1;
      constructor(url) {
        super();
        this.url = String(url);
        probe.source = this;
      }
      close() {
        this.readyState = 2;
      }
      emit(type, data, seq) {
        this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: `check:${seq}` }));
      }
    };
    const sample = () => {
      const el = document.querySelector('section[aria-live="polite"]');
      const rows = el?.querySelectorAll(".md-table tbody tr").length ?? 0;
      if (probe.sampling && !probe.done && rows >= 10 && rows < 300) {
        probe.samples.push(el.scrollHeight - el.clientHeight - el.scrollTop);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    await json(route, { sessionId, status: "running", queued: false, queueDepth: 0, runId: "check-run" }, 202);
    await page.waitForFunction(() => Boolean(window.__scrollCheck.source));
    await page.evaluate(() => {
      const probe = window.__scrollCheck;
      let seq = 1;
      probe.source.emit("run_start", { runId: "check-run", prompt: "テーブル", startedAt: Date.now() }, seq++);
      const text =
        [
          "| No | A | B | C |",
          "|---:|---|---|---|",
          ...Array.from({ length: 300 }, (_, i) => `| ${i + 1} | あ | あ | あ |`),
        ].join("\n") + "\n";
      let offset = 0;
      const tick = () => {
        if (offset >= text.length) {
          probe.done = true;
          probe.source.emit(
            "run_end",
            { runId: "check-run", status: "completed", queueDepth: 0, messageCount: 2 },
            seq++,
          );
          return;
        }
        probe.source.emit("text", { delta: text.slice(offset, offset + 8) }, seq++);
        offset += 8;
        setTimeout(tick, 18);
      };
      setTimeout(tick, 100);
    });
  });

  const narrow = page.url().includes("narrow");
  await page.setViewportSize(narrow ? { width: 390, height: 844 } : { width: 1180, height: 712 });
  await page.reload();
  await page.locator('textarea[placeholder*="メッセージを入力"]').fill("テーブル再現");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".md-table tbody tr").length >= 100, undefined, {
    timeout: 90000,
  });

  // 読み返し中に行が増えても、末尾へ引き戻されない。
  const reading = await page.evaluate(() => {
    window.__scrollCheck.sampling = false;
    const el = document.querySelector('section[aria-live="polite"]');
    el.scrollTop -= 200;
    return { top: el.scrollTop, rows: el.querySelectorAll(".md-table tbody tr").length };
  });
  const latest = page.getByRole("button", { name: "最新のメッセージへ移動" });
  await latest.waitFor({ state: "visible" });
  const readingAnchor = await page
    .locator('section[aria-live="polite"]')
    .evaluate((el) => getComputedStyle(el).overflowAnchor);
  if (readingAnchor !== "auto") throw new Error(`読み返し中のアンカリング: ${readingAnchor}`);
  await page.waitForFunction(
    (rows) => document.querySelectorAll(".md-table tbody tr").length >= rows + 10,
    reading.rows,
  );
  const readingTop = await page.locator('section[aria-live="polite"]').evaluate((el) => el.scrollTop);
  if (Math.abs(readingTop - reading.top) > 1) throw new Error(`読み返し中に移動: ${reading.top} → ${readingTop}`);
  await latest.click();
  const followingAnchor = await page
    .locator('section[aria-live="polite"]')
    .evaluate((el) => getComputedStyle(el).overflowAnchor);
  if (followingAnchor !== "none") throw new Error(`追従中のアンカリング: ${followingAnchor}`);
  await page.evaluate(() => {
    window.__scrollCheck.sampling = true;
  });
  await page.waitForFunction(() => window.__scrollCheck.done, undefined, { timeout: 90000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('section[aria-live="polite"]');
    return el.scrollHeight - el.clientHeight - el.scrollTop <= 1;
  });
  const gaps = await page.evaluate(() => window.__scrollCheck.samples);
  if (gaps.length < 100) throw new Error(`サンプル不足: ${gaps.length}`);
  const maxGap = Math.max(...gaps);
  if (maxGap > 1) throw new Error(`描画前の末尾追従が遅延: ${maxGap}px`);

  // 容器のリサイズでも追従を維持する。
  await page.setViewportSize(narrow ? { width: 844, height: 390 } : { width: 820, height: 900 });
  await page.waitForFunction(() => {
    const el = document.querySelector('section[aria-live="polite"]');
    return el.scrollHeight - el.clientHeight - el.scrollTop <= 1;
  });
  return {
    viewport: narrow ? "390x844" : "1180x712",
    rows: 300,
    samples: gaps.length,
    maxGap,
    readingPositionPreserved: true,
    latestAndResize: true,
  };
}
