import assert from "node:assert/strict";
import test from "node:test";
import { deriveRuntimeModelDiagnostics, runtimeVersionInfo, sanitizeRuntimeAuth } from "../src/agent";
import type { ModelRef } from "../src/schema";
import { stubModel, STUB_MODEL } from "./stub-pi";

const filteredModel = stubModel({ provider: "secured", id: "filtered", name: "Filtered", reasoning: false });
const whitelistExcludedModel = stubModel({
  provider: "secured",
  id: "outside",
  name: "Outside whitelist",
  reasoning: false,
});
const unauthenticatedModel = stubModel({ provider: "locked", id: "model", name: "Locked", reasoning: false });

function derive(requestedModel?: ModelRef) {
  return deriveRuntimeModelDiagnostics({
    catalog: [STUB_MODEL, filteredModel, whitelistExcludedModel, unauthenticatedModel],
    available: [STUB_MODEL, whitelistExcludedModel],
    providerIds: ["stub", "secured", "locked"],
    authStatuses: new Map([
      ["stub", { configured: true, source: "environment", label: "STUB_API_KEY, value=super-secret" }],
      ["secured", { configured: true, source: "future-sdk-source", label: "do-not-disclose" }],
      ["locked", { configured: false }],
    ]),
    whitelist: [
      { provider: "stub", id: "stub-model" },
      { provider: "secured", id: "filtered" },
      { provider: "secured", id: "filtered" },
    ],
    requestedModel,
    versions: { piCodingAgent: "0.87.1", piAi: "0.87.1" },
  });
}

test("model diagnostics classify configured references in the required priority order", () => {
  assert.equal(derive({ provider: "future", id: "model" }).summary.piModel?.status, "unknown_provider");
  assert.equal(derive({ provider: "secured", id: "absent" }).summary.piModel?.status, "catalog_missing");
  assert.equal(derive({ provider: "locked", id: "model" }).summary.piModel?.status, "unauthenticated");
  assert.equal(derive({ provider: "secured", id: "outside" }).summary.piModel?.status, "not_in_whitelist");
  assert.equal(derive({ provider: "stub", id: "stub-model" }).summary.piModel?.status, "available");
  assert.equal(derive({ provider: "secured", id: "filtered" }).summary.piModel?.status, "not_available");
  assert.equal(
    derive({ provider: "locked", id: "model" }).summary.providers?.find(({ provider }) => provider === "locked")?.auth
      .configured,
    false,
    "a referenced unauthenticated provider remains in the summary",
  );
});

test("runtime model catalog keeps availability independent from whitelist and counts unique matches", () => {
  const result = derive();
  assert.equal(result.catalog.whitelistConfigured, true);
  assert.equal(result.catalog.catalogCount, 4);
  assert.equal(
    result.catalog.whitelistCount,
    2,
    "duplicate whitelist entries do not inflate the matched catalog count",
  );
  assert.equal(result.catalog.availableCount, 2);
  assert.deepEqual(
    result.summary.piModels?.map(({ id, status, inWhitelist }) => [id, status, inWhitelist]),
    [
      ["stub-model", "available", true],
      ["filtered", "not_available", true],
      ["filtered", "not_available", true],
    ],
  );
  const securedModels = result.catalog.providers.find(({ provider }) => provider === "secured")?.models;
  assert.deepEqual(
    securedModels?.map(({ id, available, inWhitelist }) => [id, available, inWhitelist]),
    [
      ["filtered", false, true],
      ["outside", true, false],
    ],
  );
});

test("auth source preserves supported and future values without exposing labels or credential values", () => {
  assert.deepEqual(
    sanitizeRuntimeAuth({ configured: true, source: "environment", label: "STUB_API_KEY, value=super-secret" }),
    { configured: true, source: "environment", environmentVariables: ["STUB_API_KEY"] },
  );
  assert.deepEqual(sanitizeRuntimeAuth({ configured: true, source: "models_json_command", label: "private command" }), {
    configured: true,
    source: "models_json_command",
    environmentVariables: [],
  });
  for (const source of ["stored", "runtime", "fallback", "models_json_key"]) {
    assert.equal(sanitizeRuntimeAuth({ configured: true, source }).source, source);
  }
  assert.deepEqual(sanitizeRuntimeAuth({ configured: true, source: "future-sdk-source", label: "do-not-disclose" }), {
    configured: true,
    source: "unknown",
    environmentVariables: [],
  });

  const serialized = JSON.stringify(derive().catalog);
  assert.match(serialized, /STUB_API_KEY/);
  assert.doesNotMatch(serialized, /super-secret|do-not-disclose|value=/);
});

test("runtime versions include the SDK version and only a configured commit hash", () => {
  const versions = runtimeVersionInfo({ COMMIT_HASH: "test-build" });
  assert.equal(typeof versions.piCodingAgent, "string");
  assert.equal(versions.commitHash, "test-build");
  assert.equal(runtimeVersionInfo({}).commitHash, undefined);
});

test("an unset whitelist includes every catalog model and reports that it is unrestricted", () => {
  const result = deriveRuntimeModelDiagnostics({
    catalog: [STUB_MODEL],
    available: [],
    providerIds: ["stub"],
    authStatuses: new Map([["stub", { configured: true, source: "stored" }]]),
    whitelist: undefined,
    requestedModel: undefined,
    versions: { piCodingAgent: "0.87.1" },
  });
  assert.equal(result.summary.whitelistConfigured, false);
  assert.equal(result.catalog.whitelistCount, 1);
  assert.equal(result.catalog.providers[0]?.models[0]?.inWhitelist, true);
});
