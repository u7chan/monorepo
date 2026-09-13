// サンドボックス未設定の 503 を「APIキー未設定」と誤表示しないための回帰テスト。
//
// 認証もサンドボックス未設定も 503 になり HTTP ステータスでは区別できない。
// そのため本文の判定 (runtimeStatusForError) と health の sandboxConfigured
// (runtimeStatusForHealth) から状態が決まることを検証する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_REQUIRED_TEXT,
  SANDBOX_REQUIRED_GUIDE,
  SANDBOX_REQUIRED_TEXT,
  runtimeStatusForError,
  runtimeStatusForHealth,
} from "../src/hooks/runtimeStatus";
import type { Health } from "../src/types";

// server/src/agent.ts の AUTH_REQUIRED_MESSAGE / SANDBOX_NOT_CONFIGURED_MESSAGE と同じ形の本文
const AUTH_ERROR =
  "APIキーが未設定です。ANTHROPIC_API_KEY などのプロバイダー用キーを設定するか、保存済みの認証情報を確認してからサーバーを再起動してください。";
const SANDBOX_ERROR =
  "サンドボックスが設定されていません。PI_SANDBOX_URL と PI_SANDBOX_TOKEN を設定してサーバーを再起動してください (ローカルでのツール実行にはフォールバックしません)。";

/** ステータス付きのエラーを再現する (ApiError 本体は location を参照するため読み込まない) */
const apiError = (message: string, status = 503): Error => Object.assign(new Error(message), { status });

const health = (overrides: Partial<Health> = {}): Health =>
  Object.assign({ cwd: "/tmp/project", ready: true }, overrides);

test("本文が認証エラーなら 503 でも APIキー未設定として扱う", () => {
  const status = runtimeStatusForError(apiError(AUTH_ERROR));
  assert.equal(status.authRequired, true);
  assert.equal(status.text, AUTH_REQUIRED_TEXT);
  assert.equal(status.sandboxRequired, undefined);
});

test("サンドボックス未設定の 503 は APIキー未設定にしない", () => {
  const status = runtimeStatusForError(apiError(SANDBOX_ERROR));
  assert.equal(status.text, SANDBOX_REQUIRED_TEXT);
  assert.equal(status.sandboxRequired, true);
  assert.notEqual(status.authRequired, true);
  assert.equal(status.detail, SANDBOX_ERROR);
});

test("原因の分からない 503 は APIキー未設定にしない", () => {
  const status = runtimeStatusForError(apiError("HTTP 503"));
  assert.equal(status.text, "エラー");
  assert.notEqual(status.authRequired, true);
  assert.notEqual(status.sandboxRequired, true);
});

test("復旧手順はサンドボックス側へ渡す環境変数まで示す", () => {
  // 警告内のコマンドは README のローカル起動手順と揃える。`.env` は BFF しか読まないため、
  // サンドボックスの起動コマンド自体にトークン・作業領域・bind アドレスが必要。
  const command = SANDBOX_REQUIRED_GUIDE.slice(0, SANDBOX_REQUIRED_GUIDE.indexOf("pnpm start:sandbox"));
  for (const token of ["SANDBOX_HOST=127.0.0.1", "PI_SANDBOX_TOKEN=<16文字以上", "PI_SANDBOX_CWD=$PWD"]) {
    assert.ok(command.includes(token), token);
  }
  // BFF 側の接続情報と、BFF の作業領域をサンドボックスと揃える指示も必要
  assert.ok(SANDBOX_REQUIRED_GUIDE.includes("PI_SANDBOX_URL=http://127.0.0.1:8080"));
  assert.ok(SANDBOX_REQUIRED_GUIDE.includes("PI_APP_CWD"));
  assert.ok(SANDBOX_REQUIRED_GUIDE.includes("README"));
});

test("ready: true かつ sandboxConfigured: false なら実行環境の案内を出す", () => {
  const status = runtimeStatusForHealth(health({ sandboxConfigured: false }));
  assert.equal(status.text, SANDBOX_REQUIRED_TEXT);
  assert.equal(status.error, true);
  assert.equal(status.sandboxRequired, true);
  assert.notEqual(status.authRequired, true);
});

test("ready: true では既定モデルのエラーより実行環境の未設定を先に知らせる", () => {
  const status = runtimeStatusForHealth(health({ sandboxConfigured: false, defaultModelError: "no model" }));
  assert.equal(status.sandboxRequired, true);
});

test("認証エラー・初期化失敗は実行環境の未設定より優先する", () => {
  const auth = runtimeStatusForHealth(
    health({ ready: false, errorCode: "authentication_required", sandboxConfigured: false }),
  );
  assert.equal(auth.text, AUTH_REQUIRED_TEXT);
  assert.equal(auth.authRequired, true);
  assert.notEqual(auth.sandboxRequired, true);

  const broken = runtimeStatusForHealth(
    health({ ready: false, errorCode: "runtime_unavailable", error: "初期化に失敗しました", sandboxConfigured: false }),
  );
  assert.equal(broken.text, "ランタイム未接続");
  assert.equal(broken.detail, "初期化に失敗しました");
  assert.notEqual(broken.sandboxRequired, true);
});

test("既定モデルが使えないときはモデル未選択として知らせる", () => {
  const status = runtimeStatusForHealth(
    health({ sandboxConfigured: true, defaultModelError: "Model is not available: a/b" }),
  );
  assert.equal(status.text, "モデル未選択");
  assert.equal(status.detail, "Model is not available: a/b");
  assert.notEqual(status.authRequired, true);
});

test("正常な health で接続中へ戻る", () => {
  const status = runtimeStatusForHealth(health({ sandboxConfigured: true }));
  assert.deepEqual(status, { text: "接続中", error: false });
});
