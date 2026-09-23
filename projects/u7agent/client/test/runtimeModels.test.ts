import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeModelsResponse } from "../src/types";
import { runtimeDiagnosticRows, runtimeProviderRows, runtimeProviderSummaryRows } from "../src/lib/runtimeModels";

const response: RuntimeModelsResponse = {
  whitelistConfigured: true,
  catalogCount: 3,
  whitelistCount: 2,
  availableCount: 2,
  versions: { piCodingAgent: "0.87.1" },
  providers: [
    {
      provider: "stub",
      auth: { configured: true, source: "environment", environmentVariables: ["STUB_API_KEY"] },
      models: [
        { id: "first", name: "First", available: true, inWhitelist: true },
        { id: "second", name: "Second", available: true, inWhitelist: false },
      ],
    },
    {
      provider: "locked",
      auth: { configured: false, environmentVariables: [] },
      models: [{ id: "third", name: "Third", available: false, inWhitelist: true }],
    },
  ],
};

test("diagnostic display rows preserve PI_MODELS order and duplicates", () => {
  const rows = runtimeDiagnosticRows({
    piModel: {
      provider: "stub",
      id: "second",
      status: "not_in_whitelist",
      cataloged: true,
      authenticated: true,
      available: true,
      inWhitelist: false,
    },
    piModels: [
      {
        provider: "stub",
        id: "first",
        status: "available",
        cataloged: true,
        authenticated: true,
        available: true,
        inWhitelist: true,
      },
      {
        provider: "stub",
        id: "first",
        status: "available",
        cataloged: true,
        authenticated: true,
        available: true,
        inWhitelist: true,
      },
    ],
  });
  assert.equal(rows.piModel?.label, "stub/second");
  assert.equal(rows.piModel?.statusLabel, "whitelist 対象外");
  assert.deepEqual(
    rows.piModels.map(({ key, label }) => [key, label]),
    [
      ["pi-models-0", "stub/first"],
      ["pi-models-1", "stub/first"],
    ],
  );
});

test("catalog display rows count availability and whitelist independently and keep unauthenticated providers", () => {
  const rows = runtimeProviderRows(response);
  assert.deepEqual(
    rows.map(({ provider, authLabel, catalogCount, whitelistCount, availableCount }) => [
      provider,
      authLabel,
      catalogCount,
      whitelistCount,
      availableCount,
    ]),
    [
      ["stub", "認証済み", 2, 1, 2],
      ["locked", "未認証", 1, 1, 0],
    ],
  );
  assert.deepEqual(rows[0]?.environmentVariables, ["STUB_API_KEY"]);

  const summaries = runtimeProviderSummaryRows([
    {
      provider: "stub",
      auth: { configured: true, source: "models_json_command", environmentVariables: [] },
      catalogCount: 10,
      whitelistCount: 4,
      availableCount: 2,
    },
  ]);
  assert.deepEqual(
    [summaries[0]?.catalogCount, summaries[0]?.whitelistCount, summaries[0]?.availableCount],
    [10, 4, 2],
  );
  assert.equal(summaries[0]?.authSource, "models.json のコマンド");
});
