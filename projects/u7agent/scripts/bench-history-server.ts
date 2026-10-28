import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { HISTORY_PAGE_LIMIT_DEFAULT, projectHistoryPage } from "../server/src/history-projection";
import { REDACTED } from "../server/src/redact";
import type { HistoryContextState, HistoryPage } from "../server/src/schema";
import { contentText } from "../server/src/session-projection";
import {
  createHistoryFixture,
  historyFixtureStats,
  mutateHistoryFixture,
  type HistoryFixture,
  type HistoryMutation,
  type HistoryProfile,
} from "./history-bench-fixture";

export interface ServerBenchOptions {
  sizes: number[];
  textChars: number;
  pages: number;
  iterations: number;
  profiles: HistoryProfile[];
}

interface ExpectedItem {
  id: string;
  entry: SessionEntry;
  context?: HistoryContextState;
  runId?: string;
  toolIds: string[];
}

export function historyExpectation(fixture: HistoryFixture) {
  const entries = fixture.manager.getBranch();
  const active = new Set<object>(fixture.record.session.messages);
  const latestCompaction = entries.findLast((entry) => entry.type === "compaction");
  const keepIndex = latestCompaction
    ? entries.findIndex((entry) => entry.id === latestCompaction.firstKeptEntryId)
    : -1;
  let runId: string | undefined;
  let toolIds: string[] = [];
  const items = entries.flatMap<ExpectedItem>((entry, index) => {
    if (entry.type === "compaction")
      return [{ id: entry.id, entry, context: undefined, runId, toolIds: [] as string[] }];
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (message.role === "user") {
      runId = fixture.record.userMessageSends.get(message)?.runId;
      toolIds = [];
    } else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") toolIds.push(part.id);
      }
    }
    if (message.role !== "user" && !(message.role === "assistant" && contentText(message.content) !== "")) return [];
    const context: HistoryContextState = active.has(message)
      ? "active"
      : keepIndex >= 0 && index < keepIndex
        ? "summarized"
        : "excluded";
    const expected = { id: entry.id, entry, context, runId, toolIds };
    toolIds = [];
    return [expected];
  });
  const messageItems = items.filter((item) => item.entry.type === "message");
  const summarizedMessageCount = messageItems.filter((item) => item.context === "summarized").length;
  return {
    items,
    indexById: new Map(items.map((item, index) => [item.id, index])),
    messageCount: messageItems.length,
    summarizedMessageCount,
    activeContextStartId:
      summarizedMessageCount > 0 ? (messageItems.find((item) => item.context === "active")?.id ?? null) : null,
    stats: historyFixtureStats(fixture),
  };
}

type Expectation = ReturnType<typeof historyExpectation>;

export function verifyHistoryPage(fixture: HistoryFixture, expected: Expectation, page: HistoryPage, before?: string) {
  const end = before === undefined ? expected.items.length : expected.indexById.get(before);
  assert.ok(end !== undefined, "benchmark cursor must exist");
  const start = Math.max(0, end - HISTORY_PAGE_LIMIT_DEFAULT);
  const selected = expected.items.slice(start, end);
  assert.equal(page.sessionId, fixture.record.id);
  assert.deepEqual(
    page.items.map((item) => item.id),
    selected.map((item) => item.id),
  );
  assert.equal(page.messageCount, expected.messageCount);
  assert.equal(page.summarizedMessageCount, expected.summarizedMessageCount);
  assert.equal(page.activeContextStartId, expected.activeContextStartId);
  assert.equal(page.hasMore, start > 0);
  assert.equal(page.nextCursor, start > 0 ? selected[0].id : null);
  assert.equal(page.prevCursor, start > 0 ? expected.items[start - 1].id : null);
  for (const [index, item] of page.items.entries()) {
    const source = selected[index];
    if (source.entry.type === "compaction") {
      assert.equal(item.kind, "compaction");
      if (item.kind !== "compaction") throw new Error("Expected compaction");
      assert.equal(item.compaction.firstKeptEntryId, source.entry.firstKeptEntryId);
      if (fixture.masker.secrets.length > 0) assert.ok(item.compaction.summary.includes(REDACTED));
      const meta = fixture.record.compactionMeta.get(source.id);
      assert.equal(item.compaction.durationMs, meta?.durationMs);
    } else {
      assert.equal(source.entry.type, "message");
      if (source.entry.type !== "message" || item.kind !== "message") throw new Error("Expected message");
      const message = source.entry.message;
      assert.ok(message.role === "user" || message.role === "assistant");
      assert.equal(item.role, message.role);
      assert.equal(item.context, source.context);
      assert.equal(item.text, contentText(message.content));
      assert.deepEqual(item.tools?.map((tool) => tool.id) ?? [], source.toolIds);
      const record = fixture.record;
      if (message.role === "user") {
        const send = record.userMessageSends.get(message);
        assert.equal(item.sendId, send?.sendId);
        assert.equal(item.runId, send?.runId);
        const outcome = source.runId === undefined ? undefined : record.runOutcomes.get(source.runId);
        assert.equal(item.runOutcome, outcome?.outcome);
        assert.equal(item.runDurationMs, outcome?.durationMs);
      } else {
        assert.equal(item.assistantId, record.assistantMessageIds.get(message));
        assert.deepEqual(item.metrics, record.messageMetrics.get(message));
        assert.deepEqual(item.turnEnd, source.runId === undefined ? undefined : record.runOutcomes.get(source.runId));
      }
    }
  }
  const serialized = JSON.stringify(page);
  for (const secret of fixture.masker.secrets) assert.ok(!serialized.includes(secret), "dummy secret must be masked");
  return {
    serializedBytes: Buffer.byteLength(serialized, "utf8"),
    checksum: createHash("sha256").update(serialized).digest("hex").slice(0, 16),
  };
}

function measurePage(fixture: HistoryFixture, expected: Expectation, before?: string) {
  const cpuStart = process.cpuUsage();
  const startedAt = performance.now();
  const result = projectHistoryPage({ record: fixture.record, masker: fixture.masker, cwd: fixture.cwd, before });
  const projectMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  assert.ok(result.ok, "projectHistoryPage must return a valid page");
  return {
    projectMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    items: result.page.items.length,
    nextCursor: result.page.nextCursor,
    ...verifyHistoryPage(fixture, expected, result.page, before),
  };
}

function measureHistoryScenario({
  fixture,
  expected,
  state,
  scenario,
  requestedPages,
  before,
  repeated = false,
}: {
  fixture: HistoryFixture;
  expected: Expectation;
  state: string;
  scenario: string;
  requestedPages: number;
  before?: string | null;
  repeated?: boolean;
}) {
  const pages: ReturnType<typeof measurePage>[] = [];
  let cursor = before;
  for (let index = 0; index < requestedPages && cursor !== null; index += 1) {
    const page = measurePage(fixture, expected, cursor);
    if (repeated && pages.length > 0) assert.equal(page.checksum, pages[0].checksum, "unchanged pages must be stable");
    pages.push(page);
    if (!repeated) cursor = page.nextCursor;
  }
  const times = pages.map((page) => page.projectMs).sort((a, b) => a - b);
  const result = {
    target: "server",
    profile: fixture.profile,
    state,
    scenario,
    ...expected.stats,
    requestedPages,
    actualPages: pages.length,
    itemCount: pages.reduce((sum, page) => sum + page.items, 0),
    projectMs: pages.reduce((sum, page) => sum + page.projectMs, 0),
    cpuMs: pages.reduce((sum, page) => sum + page.cpuMs, 0),
    medianPageMs: times.length ? times[Math.floor(times.length / 2)] : null,
    serializedBytes: pages.reduce((sum, page) => sum + page.serializedBytes, 0),
    pages,
  };
  console.log(JSON.stringify(result));
  return pages[0]?.nextCursor ?? null;
}

async function benchmarkFixture(count: number, profile: HistoryProfile, options: ServerBenchOptions) {
  const fixture = createHistoryFixture(count, profile, options.textChars);
  let expected = historyExpectation(fixture);
  let previousHeap: number | undefined;
  async function checkpoint(state: string, checkpoint: string): Promise<void> {
    // 同期 frame が直前の DTO を保持し得るため、同じ stack のまま GC しない。
    await setImmediate();
    global.gc!();
    const heapUsedBytes = process.memoryUsage().heapUsed;
    console.log(
      JSON.stringify({
        target: "server-heap",
        profile,
        state,
        checkpoint,
        ...expected.stats,
        heapUsedBytes,
        deltaFromPreviousBytes: previousHeap === undefined ? null : heapUsedBytes - previousHeap,
      }),
    );
    previousHeap = heapUsedBytes;
  }
  function measure(state: string, scenario: string, requestedPages: number, before?: string | null, repeated = false) {
    return measureHistoryScenario({ fixture, expected, state, scenario, requestedPages, before, repeated });
  }
  await checkpoint("initial", "fixture");
  const nextCursor = measure("initial", "latest-cold", 1);
  await checkpoint("initial", "after-cold");
  measure("initial", "latest-warm", options.iterations, undefined, true);
  await checkpoint("initial", "after-warm");
  measure("initial", "older-pages", options.pages, nextCursor);
  await checkpoint("initial", "after-older-pages");
  for (const mutation of ["append", "context_edit", "compaction", "run_metadata"] satisfies HistoryMutation[]) {
    mutateHistoryFixture(fixture, mutation);
    expected = historyExpectation(fixture);
    await checkpoint(mutation, "state-changed-before-projection");
    measure(mutation, "latest-after-update", 1);
    await checkpoint(mutation, "after-first-projection");
    measure(mutation, "latest-repeated-after-update", options.iterations, undefined, true);
    await checkpoint(mutation, "after-repeated-projection");
  }
}

function warmUp(options: ServerBenchOptions): void {
  for (const profile of options.profiles) {
    const fixture = createHistoryFixture(1000, profile, options.textChars);
    for (const mutation of [undefined, "append", "context_edit", "compaction", "run_metadata"] as const) {
      if (mutation) mutateHistoryFixture(fixture, mutation);
      const expected = historyExpectation(fixture);
      for (let index = 0; index < 20; index += 1) measurePage(fixture, expected);
    }
  }
}

export async function runServerBenchmark(options: ServerBenchOptions): Promise<void> {
  assert.equal(typeof global.gc, "function", "Use node --expose-gc (or pnpm bench:history-merge)");
  console.log(
    JSON.stringify({
      target: "server-config",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ...options,
    }),
  );
  warmUp(options);
  await setImmediate();
  global.gc!();
  for (const count of options.sizes) {
    for (const profile of options.profiles) await benchmarkFixture(count, profile, options);
  }
}
