// ラン失敗の分類・サニタイズの回帰テスト。
//
// 実機の TPM 429 とクォータ / 認証 / コンテキスト超過の優先順位、未分類の unknown、
// 公開文言に上流の原文 (組織IDなど) が混ざらないことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { AUTH_REQUIRED_MESSAGE } from "../src/agent";
import { classifyRunError, composeRunError, retryWaitingText, runErrorAction } from "../src/error-classify";

const TPM_429 =
  '429: {"message":"Rate limit reached for gpt-6-luna in organization org-abc123XYZ on tokens per min (TPM): Limit 200000, Used 91293, Requested 113079. Please try again in 1.311s.","type":"tokens","code":"rate_limit_exceeded"}';
const REQUEST_TOO_LARGE =
  '429: {"message":"Request too large for gpt-6-luna in organization org-abc123XYZ on tokens per min (TPM): Limit 200000, Requested 205950.","type":"tokens","code":"rate_limit_exceeded"}';
const INSUFFICIENT_QUOTA =
  '429: {"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}';
// SDK (pi-ai) の OAuth 更新失敗。モデルへ接続する前の認証解決で例外になる
const OAUTH_REFRESH_FAILED =
  'OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}';
// fetch 自体が throw した経路は prefix が違う
const OAUTH_REFRESH_UNREACHABLE =
  "OAuth refresh failed for openai-codex: OpenAI Codex token refresh error: fetch failed";
const OAUTH_INVALID_TOKEN = '401: {"error":"invalid_token","error_description":"token has expired"}';

test("classifies the screenshot TPM 429 as a retryable rate limit", () => {
  assert.deepEqual(classifyRunError(new Error(TPM_429)), { code: "rate_limit" });
  // 1 リクエストで上限超過する形も rate_limit (TPM であってコンテキスト超過ではない)
  assert.deepEqual(classifyRunError(new Error(REQUEST_TOO_LARGE)), { code: "rate_limit" });
  assert.deepEqual(classifyRunError(new Error("Too many requests, please slow down")), { code: "rate_limit" });
});

test("keeps quota, auth, and context overflow ahead of the transient rate limit", () => {
  assert.deepEqual(classifyRunError(new Error(INSUFFICIENT_QUOTA)), { code: "insufficient_quota" });
  assert.deepEqual(classifyRunError(new Error("Your credit balance is too low to access the API")), {
    code: "insufficient_quota",
  });
  assert.deepEqual(classifyRunError(new Error("GoUsageLimitError: rolling limit reached")), {
    code: "insufficient_quota",
  });
  assert.deepEqual(classifyRunError(new Error("No API key found for provider openai")), { code: "auth_required" });
  assert.deepEqual(classifyRunError(new Error("401: Incorrect API key provided")), { code: "auth_required" });
  assert.deepEqual(classifyRunError(new Error("prompt is too long: 210000 tokens > 200000 maximum")), {
    code: "context_overflow",
  });
  assert.deepEqual(classifyRunError(new Error("This model's maximum context length is 200000 tokens")), {
    code: "context_overflow",
  });
});

test("classifies a stored OAuth that cannot be refreshed as oauth_expired", () => {
  assert.deepEqual(classifyRunError(new Error(OAUTH_REFRESH_FAILED)), { code: "oauth_expired" });
  assert.deepEqual(classifyRunError(new Error(OAUTH_REFRESH_UNREACHABLE)), { code: "oauth_expired" });
  assert.deepEqual(
    classifyRunError(new Error("OAuth refresh returned a token that expires too soon for openai-codex")),
    { code: "oauth_expired" },
  );
  assert.deepEqual(classifyRunError(new Error(OAUTH_INVALID_TOKEN)), { code: "oauth_expired" });
  // カタログの更新失敗は OAuth の失効ではない
  assert.deepEqual(classifyRunError(new Error("Model refresh failed for openai: network unreachable")), {
    code: "unknown",
  });
});

test("oauth_expired guides to signing in again instead of registering an API key", () => {
  const composed = composeRunError({ code: "oauth_expired" }, 0);
  assert.match(composed, /設定 → モデル → プロバイダー のサインイン/);
  // この画面が扱えない方式 (openai-codex など) は pi /login でしか回復できない
  assert.match(composed, /同じ agent dir を使う pi \/login/);
  assert.doesNotMatch(composed, /APIキー/);
  // 再サインイン以外に回復手段が無いので、時間をおけば直ると案内しない
  assert.doesNotMatch(composed, /時間をおいて再実行/);
  assert.equal(composeRunError({ code: "oauth_expired" }, 1).includes("（自動再試行1回）"), true);
});

test("classifies a model the account cannot use as model_unavailable", () => {
  assert.deepEqual(
    classifyRunError(
      new Error(
        "Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
      ),
    ),
    { code: "model_unavailable" },
  );
  assert.deepEqual(classifyRunError(new Error("The model `gpt-4o` does not exist or you do not have access to it.")), {
    code: "model_unavailable",
  });
  assert.deepEqual(classifyRunError(new Error("models/gemini-3-pro is not found for API version v1beta")), {
    code: "model_unavailable",
  });
  assert.deepEqual(classifyRunError(new Error("ModelNotFoundError: no such model")), { code: "model_unavailable" });
});

test("model_unavailable is permanent and never advised as a retry", () => {
  const composed = composeRunError({ code: "model_unavailable" }, 0);
  assert.equal(
    composed,
    "選択したモデルは現在の契約では利用できません。入力欄の上のモデル名から、この会話のモデルを選び直してください",
  );
  // 設定 → モデル の保存は live の会話モデルを変えないため、そちらを案内しない
  assert.doesNotMatch(composed, /設定 → モデル/);
  assert.doesNotMatch(composed, /時間をおいて再実行/);
  assert.equal(composeRunError({ code: "model_unavailable" }, 2).includes("（自動再試行2回）"), true);
});

test("does not classify an unpaid 429 as a transient rate limit", () => {
  // 恒久的な利用枠エラーへ時間を置けば直ると案内しない (分類が先)
  const quota = classifyRunError(new Error(`${INSUFFICIENT_QUOTA} 429`));
  assert.equal(quota?.code, "insufficient_quota");
  assert.doesNotMatch(composeRunError(quota as { code: "insufficient_quota" }, 2), /時間をおいて再実行/);
});

test("falls back to unknown without asserting a cause, and treats empty messages as no error", () => {
  assert.deepEqual(classifyRunError(new Error("something exploded")), { code: "unknown" });
  assert.deepEqual(classifyRunError(undefined), { code: "unknown" });
  assert.deepEqual(classifyRunError({ toString: () => "plain object" }), { code: "unknown" });
  // 空メッセージは「エラー無し」の既存契約を維持する (new Error() / throw "")
  assert.equal(classifyRunError(new Error()), undefined);
  assert.equal(classifyRunError(""), undefined);
});

test("composes public messages without any upstream text", () => {
  const composed = composeRunError({ code: "rate_limit" }, 3);
  assert.equal(composed, "レート制限により実行に失敗しました（自動再試行3回）。時間をおいて再実行してください");
  assert.doesNotMatch(composed, /org-|abc123|gpt-6-luna/);
  // 認証は復旧手順込みの既存文言を正とし、案内を二重に足さない
  assert.equal(composeRunError({ code: "auth_required" }, 0), AUTH_REQUIRED_MESSAGE);
  assert.equal(runErrorAction("auth_required"), undefined);
  assert.equal(composeRunError({ code: "unknown" }, 1).includes("（自動再試行1回）"), true);
});

test("shows the remaining wait only as a rounded estimate at emission", () => {
  assert.equal(retryWaitingText("rate_limit", 1, 2, 2000), "レート制限中。約2秒後に再試行予定（1/2）");
  assert.equal(retryWaitingText("unknown", 2, 2, 4000), "エラー発生。約4秒後に再試行予定（2/2）");
  assert.equal(retryWaitingText("rate_limit", 1, 2, 0), "レート制限中。約0秒後に再試行予定（1/2）");
});
