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

export function createHudDisclosure({
  root,
  toggle,
  content,
  icon = null,
  initialCollapsed = false,
  onChange = () => {},
}) {
  if (!root || !toggle || !content) {
    return {
      setCollapsed() {},
      toggle() {},
    };
  }

  let isCollapsed = Boolean(initialCollapsed);

  function render() {
    if (isCollapsed) {
      root.classList.add("is-collapsed");
      content.style.display = "none";
    } else {
      root.classList.remove("is-collapsed");
      content.style.display = "";
    }

    content.setAttribute("aria-hidden", String(isCollapsed));
    toggle.setAttribute("aria-expanded", String(!isCollapsed));
    toggle.title = isCollapsed ? "パネルを開く" : "パネルを折りたたむ";

    if (icon) {
      icon.textContent = isCollapsed ? "+" : "-";
    }
  }

  toggle.addEventListener("click", () => {
    isCollapsed = !isCollapsed;
    render();
    onChange(isCollapsed);
  });
  render();

  return {
    setCollapsed(value) {
      isCollapsed = Boolean(value);
      render();
      onChange(isCollapsed);
    },
    toggle() {
      isCollapsed = !isCollapsed;
      render();
      onChange(isCollapsed);
    },
  };
}

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

  function render(rows, materials = []) {
    element.textContent = "";
    element.append(createModelInfoList(rows));

    if (materials.length > 0) {
      element.append(createMaterialsSection(materials));
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
      render(
        [
          ["ファイル", info.fileName],
          ["頂点", formatCount(info.vertexCount)],
          ["ポリゴン", formatCount(info.polygonCount)],
          ["サイズ", formatModelSize(info.size)],
        ],
        info.materials ?? [],
      );
    },
  };
}

function createModelInfoList(rows) {
  const list = document.createElement("dl");
  list.className = "model-info-list";

  for (const [labelText, valueText] of rows) {
    const label = document.createElement("dt");
    const value = document.createElement("dd");

    label.textContent = labelText;
    value.textContent = valueText;
    list.append(label, value);
  }

  return list;
}

function createMaterialsSection(materials) {
  const root = document.createElement("section");
  const toggle = document.createElement("button");
  const title = document.createElement("span");
  const icon = document.createElement("span");
  const content = document.createElement("div");

  root.className = "materials-panel";
  toggle.className = "materials-toggle";
  toggle.type = "button";
  title.textContent = `Materials (${materials.length})`;
  icon.className = "materials-toggle-icon";
  icon.setAttribute("aria-hidden", "true");
  content.className = "materials-list";

  toggle.append(title, icon);
  content.append(...materials.map(createMaterialRow));
  root.append(toggle, content);

  createHudDisclosure({
    root,
    toggle,
    content,
    icon,
    initialCollapsed: true,
  });

  return root;
}

function createMaterialRow(material) {
  const row = document.createElement("div");
  const index = document.createElement("span");
  const name = document.createElement("span");
  const swatch = document.createElement("span");
  const color = document.createElement("span");

  row.className = "material-row";
  index.className = "material-index";
  name.className = "material-name";
  swatch.className = "material-swatch";
  color.className = "material-color";
  index.textContent = `#${material.index}`;
  name.textContent = material.name || "-";
  swatch.style.backgroundColor = toCssColor(material.baseColor);
  swatch.title = formatColor(material.baseColor);
  swatch.setAttribute("aria-hidden", "true");
  color.textContent = formatColor(material.baseColor);

  row.append(index, name, swatch, color);

  return row;
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

function formatColor(color) {
  return `[${color.map(formatColorNumber).join(", ")}]`;
}

function formatColorNumber(value) {
  return value.toFixed(3);
}

function toCssColor(color) {
  const [r, g, b] = color.map((value) =>
    Math.round(Math.max(0, Math.min(value, 1)) * 255),
  );

  return `rgb(${r} ${g} ${b})`;
}
