// copyToClipboard のブラウザAPI分岐のユニットテスト
// (Bun には DOM が無いため、テスト内で最小限の document / window / navigator を差し替える)

import { afterEach, describe, expect, test } from "bun:test";
import { copyToClipboard } from "./copyToClipboard";

interface FakeTextarea {
  value: string;
  attributes: Map<string, string>;
  style: { position: string; left: string };
  selected: boolean;
  selection: [number, number] | null;
  setAttribute(name: string, value: string): void;
  select(): void;
  setSelectionRange(start: number, end: number): void;
}

interface FakeDom {
  textareas: FakeTextarea[];
  appended: FakeTextarea[];
  execCommandCount: number;
}

type MutableGlobals = {
  window?: unknown;
  document?: unknown;
  navigator?: unknown;
};

const globalScope = globalThis as unknown as MutableGlobals;
const originalGlobals = {
  window: globalScope.window,
  document: globalScope.document,
  navigator: globalScope.navigator,
};

function setGlobal(key: keyof MutableGlobals, value: unknown) {
  if (value === undefined) {
    delete globalScope[key];
    return;
  }

  globalScope[key] = value;
}

function installFakeDom(options: {
  secureContext: boolean;
  clipboard?: { writeText: (text: string) => Promise<void> };
  execCommandResult?: boolean;
}): FakeDom {
  const dom: FakeDom = { textareas: [], appended: [], execCommandCount: 0 };

  const fakeDocument = {
    createElement(tag: string) {
      if (tag !== "textarea") {
        throw new Error(`unexpected element: ${tag}`);
      }

      const textarea: FakeTextarea = {
        value: "",
        attributes: new Map(),
        style: { position: "", left: "" },
        selected: false,
        selection: null,
        setAttribute(name, value) {
          textarea.attributes.set(name, value);
        },
        select() {
          textarea.selected = true;
        },
        setSelectionRange(start, end) {
          textarea.selection = [start, end];
        },
      };
      dom.textareas.push(textarea);
      return textarea;
    },
    body: {
      appendChild(child: FakeTextarea) {
        dom.appended.push(child);
      },
      removeChild(child: FakeTextarea) {
        dom.appended = dom.appended.filter((item) => item !== child);
      },
    },
    execCommand(command: string) {
      if (command !== "copy") {
        throw new Error(`unexpected command: ${command}`);
      }

      dom.execCommandCount += 1;
      return options.execCommandResult ?? true;
    },
  };

  setGlobal("document", fakeDocument);
  setGlobal("window", { isSecureContext: options.secureContext });
  setGlobal("navigator", options.clipboard ? { clipboard: options.clipboard } : {});

  return dom;
}

afterEach(() => {
  setGlobal("window", originalGlobals.window);
  setGlobal("document", originalGlobals.document);
  setGlobal("navigator", originalGlobals.navigator);
});

describe("copyToClipboard", () => {
  test("Secure Context では navigator.clipboard を使い、textarea を作らない", async () => {
    const written: string[] = [];
    const dom = installFakeDom({
      secureContext: true,
      clipboard: {
        writeText: async (text) => {
          written.push(text);
        },
      },
    });

    await copyToClipboard("ghcr.io/u7chan/monorepo/portal:latest");

    expect(written).toEqual(["ghcr.io/u7chan/monorepo/portal:latest"]);
    expect(dom.textareas).toHaveLength(0);
  });

  test("clipboard が失敗したら textarea 経由へフォールバックする", async () => {
    const dom = installFakeDom({
      secureContext: true,
      clipboard: {
        writeText: async () => {
          throw new Error("NotAllowedError");
        },
      },
    });

    await copyToClipboard("nginx:alpine");

    expect(dom.execCommandCount).toBe(1);
    expect(dom.textareas).toHaveLength(1);
    // コピー後は textarea を DOM から外す
    expect(dom.appended).toHaveLength(0);
  });

  test("Secure Context でなければ clipboard を触らず textarea 経由でコピーする", async () => {
    const written: string[] = [];
    const dom = installFakeDom({
      secureContext: false,
      clipboard: {
        writeText: async (text) => {
          written.push(text);
        },
      },
    });

    await copyToClipboard("postgres:17-alpine");

    expect(written).toEqual([]);
    expect(dom.execCommandCount).toBe(1);
  });

  test("textarea は readonly で画面外に置き、全文字を選択する", async () => {
    const image = "ghcr.io/u7chan/monorepo/file-server:latest";
    const dom = installFakeDom({ secureContext: false });

    await copyToClipboard(image);

    const textarea = dom.textareas[0];
    expect(textarea?.value).toBe(image);
    expect(textarea?.attributes.get("readonly")).toBe("");
    expect(textarea?.style).toEqual({ position: "fixed", left: "-9999px" });
    expect(textarea?.selected).toBe(true);
    expect(textarea?.selection).toEqual([0, image.length]);
  });

  test("execCommand が false を返したらエラーにする", async () => {
    installFakeDom({ secureContext: false, execCommandResult: false });

    expect(copyToClipboard("redis:7")).rejects.toThrow("クリップボードへのコピーに失敗しました");
  });
});
