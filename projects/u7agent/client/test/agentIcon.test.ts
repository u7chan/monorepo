import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_ICON_BOX, agentIconOf, fitIconSize, isAgentIcon } from "../src/lib/agentIcon";
import type { AgentDef } from "../src/types";

const dataUrl = (mime: string, bytes: number): string =>
  `data:image/${mime};base64,${Buffer.alloc(bytes, 1).toString("base64")}`;

const agent = (id: string, icon?: string): AgentDef => ({
  id,
  name: id,
  description: "",
  systemPrompt: "",
  skillIds: [],
  ...(icon ? { icon } : {}),
});

test("fitIconSize はアスペクト比を保って箱へ収める", () => {
  // 大きい写真は長辺が箱に揃う
  assert.deepEqual(fitIconSize(4000, 3000), { width: 256, height: 192 });
  assert.deepEqual(fitIconSize(3000, 4000), { width: 192, height: 256 });
  assert.deepEqual(fitIconSize(512, 512), { width: 256, height: 256 });

  // 箱に収まる画像は拡大しない
  assert.deepEqual(fitIconSize(64, 32), { width: 64, height: 32 });

  // 極端な比率でも 1px を割らない
  assert.deepEqual(fitIconSize(4000, 1), { width: 256, height: 1 });
  assert.deepEqual(fitIconSize(1, 4000), { width: 1, height: 256 });

  // 寸法が取れなかったときは 1px に寄せる (丸めで箱を超えない)
  assert.deepEqual(fitIconSize(0, Number.NaN), { width: 1, height: 1 });
  assert.equal(AGENT_ICON_BOX, 256);

  // 圧縮しきれないときは小さい箱で再試行する
  assert.deepEqual(fitIconSize(1000, 500, 128), { width: 128, height: 64 });
});

test("isAgentIcon は webp / png の data URL だけを 16 KiB まで受理する", () => {
  assert.equal(isAgentIcon(dataUrl("webp", 1024)), true);
  assert.equal(isAgentIcon(dataUrl("png", 16 * 1024)), true);
  assert.equal(isAgentIcon(dataUrl("png", 16 * 1024 + 1)), false);

  const rejected: unknown[] = [
    undefined,
    null,
    42,
    "",
    "https://example.com/icon.png",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/jpeg;base64,/9j/4A==",
    "data:image/png;base64,",
    "data:image/png;base64,AAA",
  ];
  for (const value of rejected) {
    assert.equal(isAgentIcon(value), false, `must reject ${String(value)}`);
  }
});

test("agentIconOf はカタログから agentId のアイコンを引く", () => {
  const icon = dataUrl("webp", 64);
  const agents = [agent("agent-general"), agent("agent-code", icon)];

  assert.equal(agentIconOf(agents, "agent-code"), icon);
  // 未設定・未知の id・削除済みのセッションは undefined (表示側が SparkleIcon へ落とす)
  assert.equal(agentIconOf(agents, "agent-general"), undefined);
  assert.equal(agentIconOf(agents, "agent-missing"), undefined);
  assert.equal(agentIconOf(agents, undefined), undefined);
  // 壊れた値は描画しない
  assert.equal(agentIconOf([agent("agent-code", "data:image/svg+xml;base64,PHN2Zy8+")], "agent-code"), undefined);
});
