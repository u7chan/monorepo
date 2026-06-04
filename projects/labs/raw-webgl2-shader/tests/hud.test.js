import { afterEach, describe, expect, test } from "bun:test";
import { createHudDisclosure, createModelInfoPanel } from "../src/hud.js";

const originalDocument = globalThis.document;

afterEach(() => {
  if (originalDocument === undefined) {
    delete globalThis.document;
    return;
  }

  globalThis.document = originalDocument;
});

describe("createHudDisclosure", () => {
  test("初期状態で折りたためる", () => {
    const elements = createDisclosureElements();

    createHudDisclosure({
      ...elements,
      initialCollapsed: true,
    });

    expect(elements.root.classList.contains("is-collapsed")).toBe(true);
    expect(elements.content.style.display).toBe("none");
    expect(elements.content.getAttribute("aria-hidden")).toBe("true");
    expect(elements.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(elements.icon.textContent).toBe("+");
  });

  test("ボタンで開閉状態を切り替える", () => {
    const elements = createDisclosureElements();
    const changes = [];

    createHudDisclosure({
      ...elements,
      onChange(value) {
        changes.push(value);
      },
    });
    elements.toggle.dispatchEvent(new Event("click"));
    elements.toggle.dispatchEvent(new Event("click"));

    expect(changes).toEqual([true, false]);
    expect(elements.root.classList.contains("is-collapsed")).toBe(false);
    expect(elements.content.style.display).toBe("");
    expect(elements.content.getAttribute("aria-hidden")).toBe("false");
    expect(elements.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(elements.icon.textContent).toBe("-");
  });
});

describe("createModelInfoPanel", () => {
  test("Materialsセクションをデフォルトで閉じて表示する", () => {
    globalThis.document = createFakeDocument();
    const panel = document.createElement("section");

    createModelInfoPanel(panel).setModelInfo({
      fileName: "sample.glb",
      materials: [
        {
          baseColor: [0.25, 0.5, 0.75],
          index: 0,
          name: "Body",
        },
      ],
      polygonCount: 1,
      size: [1, 2, 3],
      vertexCount: 3,
    });

    const materials = panel.children[1];
    const toggle = materials.children[0];
    const content = materials.children[1];
    const icon = toggle.children[1];
    const row = content.children[0];

    expect(materials.classList.contains("materials-panel")).toBe(true);
    expect(toggle.children[0].textContent).toBe("Materials (1)");
    expect(row.children[3].textContent).toBe("[0.250, 0.500, 0.750]");
    expect(content.style.display).toBe("none");
    expect(content.getAttribute("aria-hidden")).toBe("true");
    expect(icon.textContent).toBe("+");

    toggle.dispatchEvent(new Event("click"));

    expect(content.style.display).toBe("");
    expect(content.getAttribute("aria-hidden")).toBe("false");
    expect(icon.textContent).toBe("-");
  });
});

function createDisclosureElements() {
  const classNames = new Set();
  const contentAttributes = new Map();
  const attributes = new Map();
  const icon = { textContent: "" };
  const toggle = Object.assign(new EventTarget(), {
    title: "",
    getAttribute(name) {
      return attributes.get(name);
    },
    querySelector(selector) {
      return selector === "[aria-hidden='true']" ? icon : null;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
  });

  return {
    content: {
      style: { display: "" },
      getAttribute(name) {
        return contentAttributes.get(name);
      },
      setAttribute(name, value) {
        contentAttributes.set(name, value);
      },
    },
    icon,
    root: {
      classList: {
        add(className) {
          classNames.add(className);
        },
        contains(className) {
          return classNames.has(className);
        },
        remove(className) {
          classNames.delete(className);
        },
        toggle(className, force) {
          if (force) {
            classNames.add(className);
            return true;
          }

          classNames.delete(className);
          return false;
        },
      },
    },
    toggle,
  };
}

function createFakeDocument() {
  return {
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  };
}

class FakeElement extends EventTarget {
  #attributes = new Map();
  #classNames = new Set();
  #textContent = "";

  constructor(tagName) {
    super();
    this.children = [];
    this.style = {};
    this.tagName = tagName.toUpperCase();
    this.title = "";
    this.type = "";
    this.classList = {
      add: (className) => {
        this.#classNames.add(className);
      },
      contains: (className) => this.#classNames.has(className),
      remove: (className) => {
        this.#classNames.delete(className);
      },
    };
  }

  get className() {
    return Array.from(this.#classNames).join(" ");
  }

  set className(value) {
    this.#classNames = new Set(value.split(/\s+/).filter(Boolean));
  }

  get textContent() {
    return this.#textContent;
  }

  set textContent(value) {
    this.#textContent = value;

    if (value === "") {
      this.children = [];
    }
  }

  append(...children) {
    this.children.push(...children.flat());
  }

  getAttribute(name) {
    return this.#attributes.get(name);
  }

  setAttribute(name, value) {
    this.#attributes.set(name, value);
  }
}
