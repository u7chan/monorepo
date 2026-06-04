import { describe, expect, test } from "bun:test";
import { createOrbitCamera } from "../src/renderer.js";

describe("createOrbitCamera", () => {
  test("2本指のピンチアウトで拡大する", () => {
    const canvas = createTestCanvas();
    const camera = createOrbitCamera(canvas);

    dispatchPointer(canvas, "pointerdown", {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    dispatchPointer(canvas, "pointerdown", {
      clientX: 0,
      clientY: 100,
      pointerId: 2,
    });
    dispatchPointer(canvas, "pointermove", {
      clientX: 0,
      clientY: 200,
      pointerId: 2,
    });

    expect(camera.getViewScale()).toBe(0.5);
  });

  test("2本指のピンチインで縮小する", () => {
    const canvas = createTestCanvas();
    const camera = createOrbitCamera(canvas);

    dispatchPointer(canvas, "pointerdown", {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    dispatchPointer(canvas, "pointerdown", {
      clientX: 0,
      clientY: 200,
      pointerId: 2,
    });
    dispatchPointer(canvas, "pointermove", {
      clientX: 0,
      clientY: 100,
      pointerId: 2,
    });

    expect(camera.getViewScale()).toBe(2);
  });

  test("1本指では既存どおり回転する", () => {
    const canvas = createTestCanvas();
    const camera = createOrbitCamera(canvas);
    const initialEye = camera.getEye();

    dispatchPointer(canvas, "pointerdown", {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    dispatchPointer(canvas, "pointermove", {
      clientX: 40,
      clientY: 0,
      pointerId: 1,
    });

    expect(camera.getEye()).not.toEqual(initialEye);
  });
});

function createTestCanvas() {
  const captures = new Set();

  return Object.assign(new EventTarget(), {
    clientHeight: 1000,
    classList: {
      add() {},
      remove() {},
    },
    hasPointerCapture(pointerId) {
      return captures.has(pointerId);
    },
    releasePointerCapture(pointerId) {
      captures.delete(pointerId);
    },
    setPointerCapture(pointerId) {
      captures.add(pointerId);
    },
  });
}

function dispatchPointer(canvas, type, options) {
  const event = new Event(type, { cancelable: true });

  Object.assign(event, {
    button: 0,
    clientX: options.clientX,
    clientY: options.clientY,
    pointerId: options.pointerId,
    pointerType: "touch",
  });
  canvas.dispatchEvent(event);

  return event;
}
