import { formatModelSize } from "./model-info.js";

const FPS_UPDATE_INTERVAL = 0.25;
const SAMPLER_NAMES = {
  33071: "CLAMP",
  33648: "MIRROR",
  9728: "NEAREST",
  9729: "LINEAR",
  9984: "NEAREST_MIP_NEAREST",
  9985: "LINEAR_MIP_NEAREST",
  9986: "NEAREST_MIP_LINEAR",
  9987: "LINEAR_MIP_LINEAR",
  10497: "REPEAT",
};

const CONTROL_ITEMS = [
  ["surfaceVisible", "面"],
  ["wireframeVisible", "ワイヤー"],
  ["texturesVisible", "テクスチャ"],
  ["useVertexColors", "頂点色"],
  ["lightingEnabled", "ライト"],
  ["gridVisible", "グリッド"],
  ["axesVisible", "軸"],
  ["autoFitModel", "自動フィット"],
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

  function render(rows, materials = [], textures = []) {
    element.textContent = "";
    element.append(createModelInfoList(rows));

    if (materials.length > 0) {
      element.append(createMaterialsSection(materials));
    }

    if (textures.length > 0) {
      element.append(createTexturesSection(textures));
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
          ["テクスチャ", formatCount(info.textures?.length ?? 0)],
          ["サイズ", formatModelSize(info.size)],
        ],
        info.materials ?? [],
        info.textures ?? [],
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
  return createCollapsibleInfoSection({
    className: "materials-panel",
    contentClassName: "materials-list",
    count: materials.length,
    items: materials,
    rowFactory: createMaterialRow,
    title: "Materials",
  });
}

function createTexturesSection(textures) {
  return createCollapsibleInfoSection({
    className: "textures-panel",
    contentClassName: "textures-list",
    count: textures.length,
    items: textures,
    rowFactory: createTextureRow,
    title: "Textures",
  });
}

function createCollapsibleInfoSection({
  className,
  contentClassName,
  count,
  items,
  rowFactory,
  title: titleText,
}) {
  const root = document.createElement("section");
  const toggle = document.createElement("button");
  const title = document.createElement("span");
  const icon = document.createElement("span");
  const content = document.createElement("div");

  root.className = className;
  toggle.className = "info-section-toggle";
  toggle.type = "button";
  title.textContent = `${titleText} (${count})`;
  icon.className = "info-section-toggle-icon";
  icon.setAttribute("aria-hidden", "true");
  content.className = contentClassName;

  toggle.append(title, icon);
  content.append(...items.map(rowFactory));
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

  if (material.name) {
    name.title = material.name;
  }

  swatch.style.backgroundColor = toCssColor(material.baseColor);
  swatch.title = formatColor(material.baseColor);
  swatch.setAttribute("aria-hidden", "true");
  color.textContent = formatColor(material.baseColor);

  row.append(index, name, swatch, color);

  return row;
}

function createTextureRow(texture) {
  const row = document.createElement("div");
  const index = document.createElement("span");
  const image = document.createElement("span");
  const sampler = document.createElement("span");
  const materials = document.createElement("span");

  row.className = "texture-row";
  index.className = "texture-index";
  image.className = "texture-image";
  sampler.className = "texture-sampler";
  materials.className = "texture-materials";
  index.textContent = `#${texture.index}`;
  image.textContent = formatTextureImage(texture);
  sampler.textContent = formatTextureSampler(texture.sampler);
  sampler.title = sampler.textContent;
  materials.textContent = formatTextureMaterials(texture);
  materials.title = materials.textContent;

  row.append(index, image, sampler, materials);

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

function formatTextureImage(texture) {
  if (texture.imageIndex === null || texture.imageIndex === undefined) {
    return "image -";
  }

  return `image #${texture.imageIndex} ${formatTextureImageStatus(texture.imageStatus)}`;
}

function formatTextureImageStatus(status) {
  if (status === "decoded") {
    return "ok";
  }

  if (status === "missing") {
    return "missing";
  }

  return "-";
}

function formatTextureMaterials(texture) {
  if (!texture.materials || texture.materials.length === 0) {
    return "material -";
  }

  return texture.materials
    .map((material) => {
      const name = material.name || `#${material.index}`;

      return `${name} uv${material.texcoordIndex}`;
    })
    .join(", ");
}

function formatTextureSampler(sampler) {
  if (!sampler) {
    return "sampler -";
  }

  return [
    `S:${formatSamplerValue(sampler.wrapS)}`,
    `T:${formatSamplerValue(sampler.wrapT)}`,
    `min:${formatSamplerValue(sampler.minFilter)}`,
    `mag:${formatSamplerValue(sampler.magFilter)}`,
  ].join(" ");
}

function formatSamplerValue(value) {
  return SAMPLER_NAMES[value] ?? String(value);
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
