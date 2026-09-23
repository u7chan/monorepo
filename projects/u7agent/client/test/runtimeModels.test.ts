import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeModelsResponse } from "../src/types";
import {
  runtimeDiagnosticCounts,
  runtimeDiagnosticRows,
  runtimeMetricRatio,
  runtimeProviderRows,
  runtimeProviderSummaryRows,
} from "../src/lib/runtimeModels";

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
    rows.map(({ provider, configured, catalogCount, whitelistCount, availableCount }) => [
      provider,
      configured,
      catalogCount,
      whitelistCount,
      availableCount,
    ]),
    [
      ["stub", true, 2, 1, 2],
      ["locked", false, 1, 1, 0],
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

test("metric ratio is capped at 1 and never divides by zero", () => {
  assert.equal(runtimeMetricRatio(4, 41), 4 / 41);
  assert.equal(runtimeMetricRatio(41, 41), 1);
  assert.equal(runtimeMetricRatio(0, 41), 0);
  // whitelist 未設定では収載数がカタログ数と一致するが、数え方の違いで超えることがある
  assert.equal(runtimeMetricRatio(3, 2), 1);
  assert.equal(runtimeMetricRatio(1, 0), 0);
});

test("diagnostic counts are only returned when all three counts are present", () => {
  assert.deepEqual(
    runtimeDiagnosticCounts({ status: "available", catalogCount: 5, whitelistCount: 2, availableCount: 3 }),
    {
      catalog: 5,
      whitelist: 2,
      available: 3,
    },
  );
  assert.equal(runtimeDiagnosticCounts({ status: "available", catalogCount: 5 }), undefined);
  assert.equal(runtimeDiagnosticCounts({ status: "unavailable" }), undefined);
});
