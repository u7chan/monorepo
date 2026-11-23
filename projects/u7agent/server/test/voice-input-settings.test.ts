// 音声入力の設定サービス（キーの AEAD 保存・復号・マスカー登録・課金なしの疎通確認）。実 API は呼ばず fake db で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { VoiceInputSettingsRow } from "../src/app-db";
import {
  APP_SECRET_DECRYPT_FAILED_MESSAGE,
  APP_SECRET_MASTER_KEY_MESSAGE,
  APP_SECRET_NOT_STORED_MESSAGE,
  APP_SECRET_UNEVALUATED_MESSAGE,
} from "../src/app-secrets";
import {
  VOICE_INPUT_KEY_NOT_STORED_MESSAGE,
  VOICE_INPUT_KEY_UNAVAILABLE_MESSAGE,
  VOICE_INPUT_MODEL,
  VOICE_INPUT_NOT_CONFIGURED_MESSAGE,
  VOICE_INPUT_RUNTIME_UNAVAILABLE_MESSAGE,
  VOICE_INPUT_SETTINGS_NOT_STORED_MESSAGE,
  VOICE_INPUT_TEST_INVALID_RESPONSE_MESSAGE,
  VOICE_INPUT_TEST_RUNTIME_UNAVAILABLE_MESSAGE,
  VoiceInputSettingsService,
  type VoiceInputSettingsDb,
} from "../src/voice-input";
import { encryptedSecret, testAppCipher } from "./app-secret-fixture";

const KEY = "sk-voice-dummy-key-0123456789abcdef";
const CIPHER = testAppCipher();

class FakeVoiceInputDb implements VoiceInputSettingsDb {
  row: VoiceInputSettingsRow | undefined;
  failRead = false;
  failSave = false;
  failDelete = false;
  /** 例外文言にキー / 暗号文の断片を載せる（実 DB のトリガーを模す） */
  secretInErrors: string | undefined;
  events: string[] = [];

  readVoiceInputSettings(): VoiceInputSettingsRow | undefined {
    if (this.failRead) throw new Error(`db read boom ${this.secretInErrors ?? ""}`);
    return this.row;
  }

  saveVoiceInputSettings(secret: VoiceInputSettingsRow): void {
    if (this.failSave) throw new Error(`db save boom ${this.secretInErrors ?? ""}`);
    this.events.push("save");
    this.row = secret;
  }

  deleteVoiceInputSettings(): boolean {
    if (this.failDelete) throw new Error(`db delete boom ${this.secretInErrors ?? ""}`);
    this.events.push("delete");
    const existed = this.row !== undefined;
    this.row = undefined;
    return existed;
  }
}

function storedKey(secret: VoiceInputSettingsRow | undefined): string | undefined {
  return secret === undefined ? undefined : CIPHER.decrypt("voice_input_settings", "apiKey", secret);
}

/** `ek_` で始まる短命キーを返す OpenAI の応答。値は入力のキーと一致しない */
const CLIENT_SECRET_RESPONSE = {
  value: "ek_short-lived-dummy-value",
  expires_at: 1_730_000_060,
  session: {
    type: "transcription",
    audio: { input: { transcription: { model: VOICE_INPUT_MODEL }, turn_detection: null } },
  },
};

/** 疎通確認の送信を記録する fetch。応答と失敗はテストから差し替える */
function recordingFetch(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return response();
  };
  return { calls, fetchImpl };
}

function openService(
  db: FakeVoiceInputDb,
  options: {
    cipher?: ReturnType<typeof testAppCipher> | null;
    runtimeAvailable?: boolean;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maskError?: (text: string) => string;
  } = {},
) {
  const retained: string[] = [];
  const service = new VoiceInputSettingsService({
    db,
    runtimeAvailable: options.runtimeAvailable ?? true,
    retainSecret: (value) => retained.push(value),
    maskError: options.maskError ?? ((text) => text),
    appCipher: options.cipher === undefined ? CIPHER : options.cipher,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { service, retained };
}

test("未設定の GET はキーが無いことを返し、保存は暗号文でマスカー登録が DB より先になる", async () => {
  const db = new FakeVoiceInputDb();
  const { service, retained } = openService(db);
  assert.deepEqual(service.settings(), {
    configured: false,
    keyStored: false,
    keyAvailable: false,
    keyEvaluated: true,
    keyErrorMessage: null,
    model: VOICE_INPUT_MODEL,
    runtimeAvailable: true,
  });
  assert.deepEqual(retained, [], "未設定では登録しない");

  const outcome = await service.putKey(KEY);
  assert.equal(outcome.status, 200);
  if (outcome.status !== 200) return;
  assert.deepEqual(outcome.response, {
    configured: true,
    keyStored: true,
    keyAvailable: true,
    keyEvaluated: true,
    keyErrorMessage: null,
    model: VOICE_INPUT_MODEL,
    runtimeAvailable: true,
    state: "applied",
  });
  // マスカーへの登録は DB より前（保存が失敗しても保護対象だけは残す）
  assert.deepEqual(retained, [KEY]);
  assert.deepEqual(db.events, ["save"]);
  assert.equal(storedKey(db.row), KEY, "平文ではなく復号できる暗号文で保存する");
  assert.ok(!JSON.stringify(db.row).includes(KEY), "保存値に平文を残さない");
  assert.ok(!JSON.stringify(outcome.response).includes(KEY), "応答にキーを載せない");
});

test("起動時の適用は保存行を復号してマスカーへ登録し、未評価と復号失敗を区別する", async () => {
  const configured = new FakeVoiceInputDb();
  configured.row = encryptedSecret("voice_input_settings", "apiKey", KEY);
  const applied = openService(configured);
  await applied.service.applyStored();
  assert.deepEqual(applied.retained, [KEY], "起動時点の行もマスカーへ登録する");
  assert.equal(applied.service.settings().keyAvailable, true);

  // 誤鍵・未知の鍵版・改ざん相当は平文へ落とさず、固定文言で利用不可にする
  const broken = new FakeVoiceInputDb();
  broken.row = { ciphertext: new Uint8Array([1, 2, 3, 4]), nonce: new Uint8Array(12), keyVersion: 99 };
  const unusable = openService(broken);
  await unusable.service.applyStored();
  const settings = unusable.service.settings();
  assert.equal(settings.keyStored, true, "行は消さない");
  assert.equal(settings.keyAvailable, false);
  assert.equal(settings.keyEvaluated, true);
  assert.equal(settings.keyErrorMessage, APP_SECRET_DECRYPT_FAILED_MESSAGE);
  assert.deepEqual(unusable.retained, []);

  // runtime が無い起動では復号しない（使う経路が無い）
  const runtimeOff = new FakeVoiceInputDb();
  runtimeOff.row = encryptedSecret("voice_input_settings", "apiKey", KEY);
  const unevaluated = openService(runtimeOff, { runtimeAvailable: false });
  await unevaluated.service.applyStored();
  assert.equal(unevaluated.service.settings().keyEvaluated, false);
  assert.equal(unevaluated.service.settings().keyErrorMessage, APP_SECRET_UNEVALUATED_MESSAGE);
  assert.deepEqual(unevaluated.retained, []);
});

test("AAD の用途を取り違えた暗号文は復号できず、保存あり・利用不可として読む", async () => {
  const db = new FakeVoiceInputDb();
  // 同じ鍵輪でも、コンテンツ生成の用途で作った暗号文は復号できない
  db.row = encryptedSecret("content_settings", "apiKey", KEY);
  const { service, retained } = openService(db);
  await service.applyStored();
  assert.equal(service.settings().keyStored, true);
  assert.equal(service.settings().keyAvailable, false);
  assert.equal(service.settings().keyErrorMessage, APP_SECRET_DECRYPT_FAILED_MESSAGE);
  assert.deepEqual(retained, []);
});

test("master key が無い起動でも保存済みキーは未設定と混同せず、削除はできる", async () => {
  const db = new FakeVoiceInputDb();
  db.row = encryptedSecret("voice_input_settings", "apiKey", KEY);
  const { service } = openService(db, { cipher: null });
  await service.applyStored();
  assert.equal(service.settings().keyStored, true);
  assert.equal(service.settings().keyAvailable, false);
  assert.equal(service.settings().keyEvaluated, true, "復号を試せない既知の失敗として評価済みにする");
  assert.equal(service.settings().keyErrorMessage, APP_SECRET_MASTER_KEY_MESSAGE);

  assert.deepEqual(await service.putKey(KEY), { status: 503, error: APP_SECRET_NOT_STORED_MESSAGE });
  // 復号が要らない削除は master key 無しでも通る
  const removed = await service.deleteKey();
  assert.equal(removed.status, 200);
  assert.equal(db.row, undefined);
  assert.equal(service.settings().keyStored, false);
});

test("pi が無い起動では登録・疎通は 503、削除は成功する", async () => {
  const db = new FakeVoiceInputDb();
  const { service, retained } = openService(db, { runtimeAvailable: false });
  assert.deepEqual(await service.putKey(KEY), { status: 503, error: VOICE_INPUT_RUNTIME_UNAVAILABLE_MESSAGE });
  assert.deepEqual(retained, [], "登録を受け付けないのでマスカーにも足さない");
  assert.equal(db.row, undefined);
  // 未登録の判定はランタイムの有無より先（先に登録を促す）
  assert.deepEqual(await service.test(), { status: 409, error: VOICE_INPUT_NOT_CONFIGURED_MESSAGE });

  // 行があっても復号していないため、ランタイム無しは「利用不可」として 503
  db.row = encryptedSecret("voice_input_settings", "apiKey", KEY);
  const unavailable = await service.keyForUse();
  assert.deepEqual(unavailable, { status: 503, error: VOICE_INPUT_TEST_RUNTIME_UNAVAILABLE_MESSAGE });

  const removed = await service.deleteKey();
  assert.equal(removed.status, 200);
  assert.equal(db.row, undefined);
});

test("キーの利用判定は未登録 409・復号不能 503・利用可 200 を分ける", async () => {
  const db = new FakeVoiceInputDb();
  const { service } = openService(db);
  assert.deepEqual(service.keyForUse(), { status: 409, error: VOICE_INPUT_NOT_CONFIGURED_MESSAGE });

  db.row = { ciphertext: new Uint8Array([1, 2, 3, 4]), nonce: new Uint8Array(12), keyVersion: 99 };
  await service.applyStored();
  assert.deepEqual(service.keyForUse(), { status: 503, error: VOICE_INPUT_KEY_UNAVAILABLE_MESSAGE });

  await service.putKey(KEY);
  assert.deepEqual(service.keyForUse(), { status: 200, apiKey: KEY });
});

test("疎通確認は短命キーの発行だけを呼び、送信の形と成功の応答を固定する", async () => {
  const db = new FakeVoiceInputDb();
  const recorder = recordingFetch(() =>
    Response.json(CLIENT_SECRET_RESPONSE, { status: 200, headers: { "content-type": "application/json" } }),
  );
  const { service } = openService(db, { fetchImpl: recorder.fetchImpl });
  await service.putKey(KEY);

  const outcome = await service.test();
  assert.deepEqual(outcome, { status: 200, response: { ok: true, model: VOICE_INPUT_MODEL } });
  assert.equal(recorder.calls.length, 1);
  const [call] = recorder.calls;
  assert.equal(call?.url, "https://api.openai.com/v1/realtime/client_secrets");
  assert.equal(call?.init?.method, "POST");
  const headers = call?.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(call?.init?.body)), {
    expires_after: { anchor: "created_at", seconds: 60 },
    session: {
      type: "transcription",
      audio: { input: { transcription: { model: VOICE_INPUT_MODEL }, turn_detection: null } },
    },
  });
  // 結果は保存しない（行は疎通の前後で変わらない）
  assert.equal(storedKey(db.row), KEY);
});

test("上流の失敗は provider-failure の分類へ寄せ、402 だけを残高不足として扱う", async () => {
  const cases: { status: number; code: string }[] = [
    { status: 401, code: "invalid_key" },
    { status: 403, code: "invalid_key" },
    { status: 402, code: "insufficient_credit" },
    { status: 429, code: "rate_limited" },
    { status: 500, code: "rate_limited" },
    { status: 400, code: "unknown" },
  ];
  for (const entry of cases) {
    const db = new FakeVoiceInputDb();
    // 上流の本文は応答・ログへ出さない（分類だけを返す）
    const recorder = recordingFetch(
      () => new Response(`upstream detail ${KEY} credit_balance_exhausted`, { status: entry.status }),
    );
    const { service } = openService(db, { fetchImpl: recorder.fetchImpl });
    await service.putKey(KEY);
    const outcome = await service.test();
    assert.equal(outcome.status, 200, `${entry.status} は 200 の ok: false`);
    if (outcome.status !== 200) continue;
    assert.equal(outcome.response.ok, false);
    if (outcome.response.ok) continue;
    assert.equal(outcome.response.code, entry.code, String(entry.status));
    assert.ok(!outcome.response.message.includes(KEY), "応答に上流の本文を載せない");
    assert.ok(!outcome.response.message.includes("credit_balance_exhausted"));
  }
});

test("2xx でも短命キーの形が違えば成功にせず、キーがそのまま返っても成功にしない", async () => {
  const responses = [
    Response.json({ value: "not-a-client-secret", session: { type: "transcription" } }),
    Response.json({ value: "ek_ok", session: { type: "realtime" } }),
    Response.json({ value: KEY, session: { type: "transcription" } }),
    new Response("not json", { status: 200 }),
  ];
  for (const response of responses) {
    const db = new FakeVoiceInputDb();
    const { service } = openService(db, { fetchImpl: async () => response });
    await service.putKey(KEY);
    const outcome = await service.test();
    assert.equal(outcome.status, 200);
    if (outcome.status !== 200) continue;
    assert.deepEqual(outcome.response, {
      ok: false,
      code: "unknown",
      message: VOICE_INPUT_TEST_INVALID_RESPONSE_MESSAGE,
    });
  }
});

test("応答が返らない疎通確認は自前の期限で中断し、タイムアウトとして返す", async () => {
  const db = new FakeVoiceInputDb();
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const { service } = openService(db, { fetchImpl: hangingFetch, timeoutMs: 1 });
  await service.putKey(KEY);
  const outcome = await service.test();
  assert.equal(outcome.status, 200);
  if (outcome.status !== 200) return;
  assert.equal(outcome.response.ok, false);
  if (outcome.response.ok) return;
  assert.equal(outcome.response.code, "timeout");
});

test("DB 例外にキーや暗号文の断片が載っても、固定文言だけを返しログへ出さない", async () => {
  const db = new FakeVoiceInputDb();
  const encrypted = encryptedSecret("voice_input_settings", "apiKey", KEY);
  const fragment = Buffer.from(encrypted.ciphertext).toString("hex").slice(0, 16);
  db.secretInErrors = `${KEY} ${fragment}`;
  const logged: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const { service } = openService(db);

    db.failSave = true;
    const save = await service.putKey(KEY);
    assert.deepEqual(save, { status: 503, error: VOICE_INPUT_KEY_NOT_STORED_MESSAGE });

    db.failRead = true;
    const use = service.keyForUse();
    assert.deepEqual(use, { status: 503, error: VOICE_INPUT_SETTINGS_NOT_STORED_MESSAGE });
    const testOutcome = await service.test();
    assert.deepEqual(testOutcome, { status: 503, error: VOICE_INPUT_SETTINGS_NOT_STORED_MESSAGE });

    db.failDelete = true;
    const removed = await service.deleteKey();
    assert.deepEqual(removed, { status: 503, error: VOICE_INPUT_SETTINGS_NOT_STORED_MESSAGE });
  } finally {
    console.warn = original;
  }
  const output = logged.join("\n");
  assert.ok(!output.includes(KEY), `ログにキーを出さない: ${output}`);
  assert.ok(!output.includes(fragment), `ログに暗号文の断片を出さない: ${output}`);
});

test("起動時の DB 読取に失敗したら未評価のまま残し、復旧後の GET で案内を出す", async () => {
  const db = new FakeVoiceInputDb();
  db.row = encryptedSecret("voice_input_settings", "apiKey", KEY);
  db.failRead = true;
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const { service } = openService(db);
    await service.applyStored();
    db.failRead = false;
    const settings = service.settings();
    assert.equal(settings.keyStored, true);
    assert.equal(settings.keyAvailable, false);
    assert.equal(settings.keyEvaluated, false, "未保存と断定せず、復号を試していない状態にする");
    assert.equal(settings.keyErrorMessage, APP_SECRET_UNEVALUATED_MESSAGE);
  } finally {
    console.error = original;
  }
  assert.ok(logged.join("\n").includes("voice input settings unavailable"));
});
