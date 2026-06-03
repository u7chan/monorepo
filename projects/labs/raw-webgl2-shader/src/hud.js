import { formatModelSize } from "./model-info.js";

const FPS_UPDATE_INTERVAL = 0.25;

const CONTROL_ITEMS = [
  ["surfaceVisible", "面"],
  ["wireframeVisible", "ワイヤー"],
  ["useVertexColors", "頂点色"],
  ["lightingEnabled", "ライト"],
  ["gridVisible", "グリッド"],
  ["axesVisible", "軸"],
];

const COLOR_ITEMS = [
  ["backgroundColor", "背景"],
  ["wireframeColor", "ワイヤー色"],
];

export function createFpsCounter(element) {
  if (!element) {
    return {
      update() {},
    };
  }

  let elapsedTime = 0;
  let frameCount = 0;

  return {
    update(deltaTime) {
      elapsedTime += deltaTime;
      frameCount += 1;

      if (elapsedTime < FPS_UPDATE_INTERVAL) {
        return;
      }

      const fps = Math.round(frameCount / elapsedTime);
      element.textContent = `${fps} FPS`;
      elapsedTime = 0;
      frameCount = 0;
    },
  };
}

export function createImportStatus(element) {
  if (!element) {
    return {
      setDragging() {},
      setError() {},
      setLoaded() {},
      setLoading() {},
      setMessage() {},
    };
  }

  let currentText = element.textContent;
  let currentState = "idle";

  function render(text, state) {
    element.textContent = text;
    element.dataset.state = state;
  }

  return {
    setDragging(isDragging) {
      if (isDragging) {
        render("Drop .gltf / .glb to import", "dragging");
        return;
      }

      render(currentText, currentState);
    },
    setError(message) {
      currentText = `Unsupported: ${message}`;
      currentState = "error";
      render(currentText, currentState);
    },
    setLoaded(fileName) {
      currentText = `Loaded: ${fileName}`;
      currentState = "loaded";
      render(currentText, currentState);
    },
    setLoading(fileName) {
      currentText = `Loading: ${fileName}`;
      currentState = "loading";
      render(currentText, currentState);
    },
    setMessage(message) {
      currentText = message;
      currentState = "idle";
      render(currentText, currentState);
    },
  };
}

export function createModelInfoPanel(element) {
  if (!element) {
    return {
      clear() {},
      setModelInfo() {},
    };
  }

  function render(rows) {
    element.textContent = "";

    for (const [labelText, valueText] of rows) {
      const label = document.createElement("dt");
      const value = document.createElement("dd");

      label.textContent = labelText;
      value.textContent = valueText;
      element.append(label, value);
    }
  }

  return {
    clear() {
      render([
        ["ファイル", "-"],
        ["頂点", "-"],
        ["ポリゴン", "-"],
        ["サイズ", "-"],
      ]);
    },
    setModelInfo(info) {
      render([
        ["ファイル", info.fileName],
        ["頂点", formatCount(info.vertexCount)],
        ["ポリゴン", formatCount(info.polygonCount)],
        ["サイズ", formatModelSize(info.size)],
      ]);
    },
  };
}

export function createRenderControls(element, renderOptions) {
  if (!element) {
    return;
  }

  for (const [key, labelText] of CONTROL_ITEMS) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    const text = document.createElement("span");

    input.type = "checkbox";
    input.checked = renderOptions[key];
    input.addEventListener("change", () => {
      renderOptions[key] = input.checked;
    });

    text.textContent = labelText;
    label.append(input, text);
    element.append(label);
  }
}

export function createColorControls(element, renderOptions, onChange = () => {}) {
  if (!element) {
    return;
  }

  for (const [key, labelText] of COLOR_ITEMS) {
    const label = document.createElement("label");
    const text = document.createElement("span");
    const input = document.createElement("input");

    input.type = "color";
    input.value = renderOptions[key];
    input.addEventListener("input", () => {
      renderOptions[key] = input.value;
      onChange(key, input.value);
    });

    text.textContent = labelText;
    label.append(text, input);
    element.append(label);
  }
}

function formatCount(value) {
  return Math.round(value).toLocaleString("ja-JP");
}
