import assert from "node:assert/strict";
import test from "node:test";
import { historyExpectation, verifyHistoryPage } from "../../scripts/bench-history-server";
import { createHistoryFixture, historyFixtureStats, mutateHistoryFixture } from "../../scripts/history-bench-fixture";
import { projectHistoryPage } from "../src/history-projection";

test("benchmark fixtures have exact entry counts, deterministic content and SDK message identity", () => {
  for (const profile of ["plain", "mixed"] as const) {
    for (const count of [4, 7, 105, 1000]) {
      const fixture = createHistoryFixture(count, profile, 40);
      const branch = fixture.manager.getBranch();
      const nextBranch = fixture.manager.getBranch();
      const duplicate = createHistoryFixture(count, profile, 40);
      assert.equal(branch.length, count);
      assert.notEqual(branch, nextBranch, "SDK traverses the parent chain into a new array");
      assert.equal(branch[0], nextBranch[0]);
      assert.deepEqual(branch, duplicate.manager.getBranch());
      const rawMessages = new Set<object>(branch.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])));
      for (const message of fixture.record.session.messages) {
        if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
          assert.ok(rawMessages.has(message), "context membership uses raw entry objects, not clones");
        }
      }
      const stats = historyFixtureStats(fixture);
      assert.equal(stats.entries, stats.messages + stats.compactions + stats.metadataEntries);
      if (profile === "plain") {
        assert.equal(stats.toolResults, 0);
        assert.equal(stats.compactions, 0);
        assert.equal(stats.registeredSecrets, 0);
      } else if (count >= 105) {
        assert.ok(stats.compactions > 0);
        assert.ok(stats.toolResults > 0);
        assert.ok(stats.summaryChars.min > 1000);
        assert.ok(stats.registeredSecrets > 0);
      }
    }
  }
});

test("metadata mutation preserves entries, leaf and context membership", () => {
  const fixture = createHistoryFixture(110, "mixed", 40);
  const branch = fixture.manager.getBranch();
  const leaf = fixture.manager.getLeafId();
  const messages = fixture.record.session.messages;
  mutateHistoryFixture(fixture, "run_metadata");
  assert.deepEqual(fixture.manager.getBranch(), branch);
  assert.equal(fixture.manager.getLeafId(), leaf);
  assert.equal(fixture.record.session.messages, messages);
  assert.deepEqual(fixture.record.runOutcomes.get("updated-run"), { outcome: "stopped", durationMs: 9876 });
});

test("benchmark assertions consume every page and each mutation without timing or GC", () => {
  for (const profile of ["plain", "mixed"] as const) {
    const fixture = createHistoryFixture(110, profile, 40);
    const duplicate = createHistoryFixture(110, profile, 40);
    const sessionManager = fixture.record.session.sessionManager;
    for (const [step, mutation] of (
      [undefined, "append", "context_edit", "compaction", "run_metadata"] as const
    ).entries()) {
      if (mutation) {
        mutateHistoryFixture(fixture, mutation);
        mutateHistoryFixture(duplicate, mutation);
      }
      assert.equal(fixture.record.session.sessionManager, sessionManager, "state updates preserve the cache owner");
      assert.deepEqual(fixture.manager.getBranch(), duplicate.manager.getBranch(), "mutations are deterministic too");
      const expected = historyExpectation(fixture);
      let before: string | undefined;
      let totalItems = 0;
      for (let guard = 0; guard < 10; guard += 1) {
        const result = projectHistoryPage({ record: fixture.record, masker: fixture.masker, cwd: fixture.cwd, before });
        assert.ok(result.ok);
        const consumed = verifyHistoryPage(fixture, expected, result.page, before);
        assert.equal(consumed.serializedBytes, Buffer.byteLength(JSON.stringify(result.page), "utf8"));
        assert.ok(consumed.serializedBytes > JSON.stringify(result.page).length, "fixture exercises multibyte text");
        const repeated = projectHistoryPage({
          record: fixture.record,
          masker: fixture.masker,
          cwd: fixture.cwd,
          before,
        });
        assert.ok(repeated.ok);
        assert.equal(verifyHistoryPage(fixture, expected, repeated.page, before).checksum, consumed.checksum);
        totalItems += result.page.items.length;
        if (result.page.nextCursor === null) break;
        before = result.page.nextCursor;
      }
      assert.equal(totalItems, expected.items.length, "pages cover the fixture without gaps or duplicates");
      assert.equal(expected.stats.entries, [110, 112, 113, 114, 114][step]);
      if (mutation === "context_edit") assert.equal(expected.items.at(-1)?.context, "excluded");
      if (mutation === "compaction") assert.ok(expected.summarizedMessageCount > 0);
    }
  }
});
