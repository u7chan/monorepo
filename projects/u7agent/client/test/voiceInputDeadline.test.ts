// 期限後の音声フレームを落とす処理（client/src/lib/voiceInput/audioDeadline.ts）と、その worker を
// 作るか諦めるかの分岐（client/src/lib/voiceInput/deadline.ts）。実 Worker / 実 RTCRtpScriptTransform は作らない。
import assert from "node:assert/strict";
import test from "node:test";
import { audioBeforeDeadline, audioDeadlineClock } from "../src/lib/voiceInput/audioDeadline";
import { makeVoiceInputAudioDeadline, voiceInputFrameDeadlineSupported } from "../src/lib/voiceInput/deadline";

test("期限前のフレームだけを通し、期限の時点と以後は落とす", async () => {
  let now = 100;
  let deadline = Number.NEGATIVE_INFINITY;
  const filter = audioBeforeDeadline(
    () => deadline,
    () => now,
  );
  const writer = filter.writable.getWriter();
  const sent: unknown[] = [];
  const done = filter.readable.pipeTo(
    new WritableStream({
      write(frame) {
        sent.push(frame);
      },
    }),
  );
  await writer.write("期限を決める前");
  now = 50;
  deadline = 200;
  await writer.write("期限の前");
  now = 199;
  await writer.write("期限の 1ms 前");
  now = 200;
  await writer.write("期限の時点");
  now = 850;
  await writer.write("画面が固まっている間の期限後");
  await writer.close();
  await done;
  assert.deepEqual(sent, ["期限の前", "期限の 1ms 前"]);
});

test("worker の時計は main thread と同じ epoch（Date.now）基準で動く", () => {
  // 期限は main thread の絶対時刻で渡すため、worker 側の時計が epoch 基準であることを固定する
  assert.ok(Math.abs(audioDeadlineClock()() - Date.now()) < 500);
});

const transformKey = "RTCRtpScriptTransform";
const workerKey = "Worker";

function withoutGlobals(names: string[]): () => void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const saved = names.map((name) => ({ name, value: scope[name], existed: name in scope }));
  for (const name of names) delete scope[name];
  return () => {
    for (const { name, value, existed } of saved) {
      if (existed) scope[name] = value;
      else delete scope[name];
    }
  };
}

test("RTCRtpScriptTransform を持たないブラウザでは worker を作らず、期限の強制だけを諦める", () => {
  const restore = withoutGlobals([transformKey, workerKey]);
  const scope = globalThis as unknown as Record<string, unknown>;
  let constructed = 0;
  scope[workerKey] = class {
    constructor() {
      constructed += 1;
      throw new Error("期限の強制を持たないブラウザで worker を作ってはいけない");
    }
  };
  let errors = 0;
  try {
    assert.equal(voiceInputFrameDeadlineSupported(), false);
    const deadline = makeVoiceInputAudioDeadline(() => {
      errors += 1;
    });
    const sender = { transform: undefined } as unknown as RTCRtpSender;
    deadline.attach(sender);
    deadline.arm(1_000);
    deadline.close();
    assert.equal(constructed, 0);
    assert.equal(errors, 0);
    assert.equal(sender.transform, undefined);
  } finally {
    restore();
  }
});

/** RTCRtpScriptTransform と Worker を差し替え、worker の起動・装着の失敗を再現する */
function installWorkerStubs({ transformThrows = false } = {}) {
  const restore = withoutGlobals([transformKey, workerKey]);
  const scope = globalThis as unknown as Record<string, unknown>;
  const workers: FakeWorker[] = [];

  class FakeWorker extends EventTarget {
    public readonly posted: unknown[] = [];
    public terminated = 0;
    public readonly url: string;
    public readonly options: { type: string };
    constructor(url: URL, options: { type: string }) {
      super();
      this.url = String(url);
      this.options = options;
      workers.push(this);
    }
    postMessage(message: unknown): void {
      this.posted.push(message);
    }
    terminate(): void {
      this.terminated += 1;
    }
  }

  class FakeTransform {
    constructor(readonly worker: FakeWorker) {
      if (transformThrows) throw new Error("transform を装着できない");
    }
  }

  scope[workerKey] = FakeWorker;
  scope[transformKey] = FakeTransform;
  return { workers, restore };
}

test("RTCRtpScriptTransform を持つブラウザでは worker を作り、期限を絶対時刻で送る", () => {
  const { workers, restore } = installWorkerStubs();
  let errors = 0;
  try {
    assert.equal(voiceInputFrameDeadlineSupported(), true);
    const deadline = makeVoiceInputAudioDeadline(() => {
      errors += 1;
    });
    assert.equal(workers.length, 1);
    assert.equal(workers[0]?.options.type, "module");
    assert.match(workers[0]?.url ?? "", /voiceAudioDeadline\.ts$/);

    const sender = { transform: undefined } as unknown as RTCRtpSender;
    deadline.attach(sender);
    assert.notEqual(sender.transform, undefined);
    deadline.arm(1_500);
    assert.deepEqual(workers[0]?.posted, [performance.timeOrigin + 1_500]);

    // worker の起動失敗と、期限後のフレームを落とせなかった通知は、どちらも録音の中止へ繋げる
    workers[0]?.dispatchEvent(new Event("error"));
    workers[0]?.dispatchEvent(new MessageEvent("message", { data: "audio-filter-error" }));
    assert.equal(errors, 2);

    deadline.close();
    assert.equal(workers[0]?.terminated, 1);
  } finally {
    restore();
  }
});

test("worker はあるが transform を装着できないときは onError で録音を中止させる", () => {
  const { workers, restore } = installWorkerStubs({ transformThrows: true });
  let errors = 0;
  try {
    const deadline = makeVoiceInputAudioDeadline(() => {
      errors += 1;
    });
    assert.equal(workers.length, 1);
    deadline.attach({} as unknown as RTCRtpSender);
    assert.equal(errors, 1);
  } finally {
    restore();
  }
});
