import { describe, expect, test } from "bun:test";
import { createHudDisclosure } from "../src/hud.js";

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
