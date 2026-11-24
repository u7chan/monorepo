// 入力欄から録音を始めるときの初回確認（client/src/lib/voiceInput/consent.ts）。確認を出す条件と、
// 取り消したときに録音を始めないこと（false を返すこと）を純関数で固定する。
import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceSettingsStorage } from "../src/lib/deviceSettingsStore";
import {
  markVoiceInputConsent,
  requestVoiceInputConsent,
  VOICE_INPUT_CONSENT_STORAGE_KEY,
  voiceInputConsentGiven,
  voiceInputConsentRequest,
} from "../src/lib/voiceInput/consent";
import type { ConfirmRequest } from "../src/lib/confirmDialog";

const storage = (initial: Record<string, string> = {}): DeviceSettingsStorage & { values: Record<string, string> } => {
  const values = { ...initial };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
};

test("未確認なら録音の前に確認を出し、承諾したら既読を残す", async () => {
  const store = storage();
  const requests: ConfirmRequest[] = [];
  const allowed = await requestVoiceInputConsent({
    storage: store,
    model: "gpt-4o-transcribe",
    confirm: async (request) => {
      requests.push(request);
      return true;
    },
  });
  assert.equal(allowed, true);
  assert.equal(requests.length, 1);
  assert.equal(store.values[VOICE_INPUT_CONSENT_STORAGE_KEY], "1");
});

test("確認を取り消したら録音を始めず、既読にしない", async () => {
  // What: 取り消しで返る false が、録音も送信も始めない判断になる
  const store = storage();
  const allowed = await requestVoiceInputConsent({ storage: store, model: "m", confirm: async () => false });
  assert.equal(allowed, false);
  assert.equal(voiceInputConsentGiven(store), false);
});

test("2 回目以降は確認を出さない", async () => {
  const store = storage();
  markVoiceInputConsent(store);
  let asked = 0;
  const allowed = await requestVoiceInputConsent({
    storage: store,
    model: "m",
    confirm: async () => {
      asked += 1;
      return false;
    },
  });
  assert.equal(allowed, true);
  assert.equal(asked, 0);
});

test("保存領域を持てない環境では、承諾しても録音を止めずに毎回確認する", () => {
  // private browsing 等で既読を残せない場合でも録音は使える（確認が毎回出るだけ）
  markVoiceInputConsent(null);
  assert.equal(voiceInputConsentGiven(null), false);
});

test("例外を投げる保存領域でも落ちない", () => {
  const broken: DeviceSettingsStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(voiceInputConsentGiven(broken), false);
  markVoiceInputConsent(broken);
});

test("確認の本文は送信先・課金・保存しないことを伝え、データの扱いへのリンクを添える", () => {
  const request = voiceInputConsentRequest("gpt-4o-transcribe");
  const body = (request.body ?? []).join("\n");
  assert.ok(body.includes("OpenAI（gpt-4o-transcribe）"), "送信先のモデル名を出す");
  assert.ok(body.includes("利用料"), "課金されることを伝える");
  assert.ok(body.includes("保存しません"), "u7agent が保存しないことを伝える");
  assert.ok(body.includes("自動送信はしません"), "録音だけで送信されないことを伝える");
  assert.equal(request.links?.length, 1, "データの取り扱いへのリンクを添える");
  assert.match(request.links?.[0]?.href ?? "", /^https:\/\//);
  assert.equal(request.confirmLabel, "録音を始める");
});
