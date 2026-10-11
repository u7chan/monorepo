// クリップボードの経路選択のテスト。DOM と clipboard は deps で差し替え、実 DOM の操作 (要素の作り方) は
// ブラウザ受入で見る。secure context の有無・writeText の成否・execCommand の戻り値の分岐を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  ClipboardCopyError,
  copyToClipboard,
  type ClipboardDeps,
  type CopyStrategy,
  type SelectionSnapshot,
} from "../src/lib/copyToClipboard";

const SNAPSHOT: SelectionSnapshot = { active: null, text: null, range: null };

type TargetBehavior = {
  /** select() が返す選択文字列。省略は本文 */
  selected?: string;
  /** select() が投げる例外 */
  selectError?: Error;
  /** execCommand() が投げる例外 */
  execError?: Error;
  /** execCommand() が返す値。省略は true */
  exec?: boolean;
};

type Harness = {
  deps: ClipboardDeps;
  /** deps が呼ばれた順 (create / focus / select / exec / remove / save / restore / writeText) */
  events: string[];
};

function harness(
  options: {
    secure?: boolean;
    /** undefined は「API 非対応」 */
    writeText?: ((text: string) => Promise<void>) | undefined;
    targets?: TargetBehavior[];
  } = {},
): Harness {
  const events: string[] = [];
  const behaviors = options.targets ?? [];
  let current: CopyStrategy | null = null;
  let created = 0;
  return {
    events,
    deps: {
      isSecureContext: options.secure ?? true,
      writeText: options.writeText,
      execCommand: () => {
        const behavior = behaviors[created - 1] ?? {};
        if (behavior.execError !== undefined) {
          events.push(`exec:${current}`);
          throw behavior.execError;
        }
        const result = behavior.exec ?? true;
        events.push(`exec:${current}:${result}`);
        return result;
      },
      createTarget: (strategy, text) => {
        created += 1;
        current = strategy;
        const behavior = behaviors[created - 1] ?? {};
        events.push(`create:${strategy}:${text}`);
        return {
          focus: () => events.push(`focus:${strategy}`),
          select: () => {
            events.push(`select:${strategy}`);
            if (behavior.selectError !== undefined) throw behavior.selectError;
            return behavior.selected ?? text;
          },
          remove: () => events.push(`remove:${strategy}`),
        };
      },
      saveSelection: () => {
        events.push("save");
        return SNAPSHOT;
      },
      restoreSelection: (snapshot) => {
        assert.equal(snapshot, SNAPSHOT);
        events.push("restore");
      },
    },
  };
}

test("secure context では clipboard API に本文を渡し、execCommand は使わない", async () => {
  const { deps, events } = harness({
    writeText: (text) => {
      events.push(`writeText:${text}`);
      return Promise.resolve();
    },
  });
  await copyToClipboard("本文", deps);
  assert.deepEqual(events, ["writeText:本文"]);
});

test("clipboard API が拒否されたら textarea の経路へ落ちる", async () => {
  const { deps, events } = harness({
    writeText: (text) => {
      events.push(`writeText:${text}`);
      return Promise.reject(new Error("denied"));
    },
  });
  await copyToClipboard("本文", deps);
  assert.deepEqual(events, [
    "writeText:本文",
    "save",
    "create:editable-textarea:本文",
    "focus:editable-textarea",
    "select:editable-textarea",
    "exec:editable-textarea:true",
    "remove:editable-textarea",
    "restore",
  ]);
});

test("非 secure context では clipboard API を呼ばず、経路でコピーする", async () => {
  const { deps, events } = harness({
    secure: false,
    writeText: () => {
      events.push("writeText");
      return Promise.resolve();
    },
  });
  await copyToClipboard("本文", deps);
  assert.ok(!events.includes("writeText"));
  assert.ok(events.includes("exec:editable-textarea:true"));
});

test("clipboard API が無い場合も経路でコピーする", async () => {
  const { deps, events } = harness();
  await copyToClipboard("本文", deps);
  assert.ok(events.includes("exec:editable-textarea:true"));
});

test("経路は editable textarea → readonly textarea → contenteditable の順に試す", async () => {
  const { deps, events } = harness({
    targets: [{ exec: false }, { selected: "" }, { exec: true }],
  });
  await copyToClipboard("本文", deps);
  assert.deepEqual(
    events.filter((event) => event.startsWith("create:")),
    ["create:editable-textarea:本文", "create:readonly-textarea:本文", "create:contenteditable:本文"],
  );
  // 選択が作れなかった経路では execCommand を呼ばない (空の選択をコピーさせない)
  assert.deepEqual(
    events.filter((event) => event.startsWith("exec:")),
    ["exec:editable-textarea:false", "exec:contenteditable:true"],
  );
});

test("本文が空のときは選択が空でも execCommand を呼ぶ", async () => {
  const { deps, events } = harness({ targets: [{ selected: "" }] });
  await copyToClipboard("", deps);
  assert.deepEqual(
    events.filter((event) => event.startsWith("exec:")),
    ["exec:editable-textarea:true"],
  );
});

test("select が例外を投げても次の経路を試す", async () => {
  const { deps, events } = harness({
    targets: [{ selectError: new Error("selection 失敗") }, { exec: true }],
  });
  await copyToClipboard("本文", deps);
  assert.deepEqual(
    events.filter((event) => event.startsWith("exec:")),
    ["exec:readonly-textarea:true"],
  );
});

test("execCommand が例外を投げても次の経路を試す", async () => {
  const { deps, events } = harness({
    targets: [{ execError: new Error("command 失敗") }, { exec: true }],
  });
  await copyToClipboard("本文", deps);
  assert.deepEqual(
    events.filter((event) => event.startsWith("exec:")),
    ["exec:editable-textarea", "exec:readonly-textarea:true"],
  );
});

test("どの経路も失敗したら内訳つきで失敗し、一時要素とフォーカスを片付ける", async () => {
  const { deps, events } = harness({ secure: false, targets: [{ exec: false }, { exec: false }, { exec: false }] });
  const error = await copyToClipboard("本文", deps).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof ClipboardCopyError);
  const detail = (error as ClipboardCopyError).message;
  assert.ok(detail.includes("非 secure context"));
  assert.ok(detail.includes("textarea: execCommand が false"));
  assert.ok(detail.includes("readonly textarea: execCommand が false"));
  assert.ok(detail.includes("contenteditable: execCommand が false"));
  assert.deepEqual(
    events.filter((event) => event.startsWith("remove:")),
    ["remove:editable-textarea", "remove:readonly-textarea", "remove:contenteditable"],
  );
  assert.deepEqual(
    events.filter((event) => event === "restore"),
    ["restore"],
  );
});

test("失敗の理由は長い例外メッセージでも切り詰める", async () => {
  const { deps } = harness({
    targets: [{ selectError: new Error("あ".repeat(400)) }, { exec: false }, { exec: false }],
  });
  const error = await copyToClipboard("本文", deps).then(
    () => null,
    (thrown: unknown) => thrown as ClipboardCopyError,
  );
  assert.ok(error instanceof ClipboardCopyError);
  assert.ok(error.message.includes("…"));
  assert.ok(!error.message.includes("あ".repeat(121)));
});
