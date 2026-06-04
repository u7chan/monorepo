import { createModelDropImporter, pickSingleModelFile } from "./drop-import.js";
import { loadGltfModelFromFile } from "./gltf.js";
import {
  createColorControls,
  createFpsCounter,
  createHudDisclosure,
  createImportStatus,
  createModelInfoPanel,
  createRenderControls,
} from "./hud.js";
import {
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_WIREFRAME_COLOR,
  normalizeHexColor,
} from "./colors.js";
import { createModelInfo } from "./model-info.js";
import { createRenderer } from "./renderer.js";

const canvas = document.querySelector("#gl-canvas");
const STORAGE_KEYS = {
  backgroundColor: "raw-webgl2.backgroundColor",
  hudCollapsed: "raw-webgl2.hudCollapsed",
  wireframeColor: "raw-webgl2.wireframeColor",
};
const COLOR_FALLBACKS = {
  backgroundColor: DEFAULT_BACKGROUND_COLOR,
  wireframeColor: DEFAULT_WIREFRAME_COLOR,
};

if (!canvas) {
  throw new Error("Canvas element #gl-canvas was not found.");
}

const renderer = createRenderer(canvas);
const fpsCounter = createFpsCounter(document.querySelector("#fps-counter"));
const importStatus = createImportStatus(document.querySelector("#import-status"));
const modelInfoPanel = createModelInfoPanel(document.querySelector("#model-info"));
const modelFileInput = document.querySelector("#model-file-input");
createHudDisclosure({
  root: document.querySelector("#hud"),
  toggle: document.querySelector("#hud-toggle"),
  content: document.querySelector("#hud-content"),
  icon: document.querySelector("#hud-toggle-icon"),
  initialCollapsed: loadInitialHudCollapsed(),
  onChange: saveHudCollapsed,
});

const gameState = {
  time: 0,
  deltaTime: 0,
  renderOptions: {
    surfaceVisible: true,
    wireframeVisible: true,
    useVertexColors: true,
    lightingEnabled: true,
    gridVisible: true,
    axesVisible: true,
    backgroundColor: loadStoredColor(
      STORAGE_KEYS.backgroundColor,
      DEFAULT_BACKGROUND_COLOR,
    ),
    wireframeColor: loadStoredColor(
      STORAGE_KEYS.wireframeColor,
      DEFAULT_WIREFRAME_COLOR,
    ),
  },
};

let lastFrameTime = null;

createRenderControls(
  document.querySelector("#render-controls"),
  gameState.renderOptions,
);
createColorControls(
  document.querySelector("#color-controls"),
  gameState.renderOptions,
  saveRenderColor,
);
modelInfoPanel.clear();

if (modelFileInput) {
  modelFileInput.addEventListener("change", handleModelFileSelection);
  modelFileInput.addEventListener("input", handleModelFileSelection);
}

let pendingFileSelection = null;

async function handleModelFileSelection() {
  const files = Array.from(modelFileInput.files ?? []);

  if (files.length === 0) {
    return;
  }

  if (pendingFileSelection === modelFileInput.files) {
    return;
  }

  pendingFileSelection = modelFileInput.files;
  importStatus.setLoading(files[0].name);

  try {
    await importModelFiles(files);
  } finally {
    pendingFileSelection = null;
    modelFileInput.value = "";
  }
}

createModelDropImporter({
  onDragChange(isDragging) {
    canvas.classList.toggle("is-drop-target", isDragging);
    document.body.classList.toggle("is-dropping-model", isDragging);
    importStatus.setDragging(isDragging);
  },
  onDropFiles: importModelFiles,
});

function update(deltaTime, time) {
  gameState.deltaTime = deltaTime;
  gameState.time = time;
}

function gameLoop(now) {
  const time = now * 0.001;
  const deltaTime =
    lastFrameTime === null ? 0 : Math.min((now - lastFrameTime) * 0.001, 0.05);
  lastFrameTime = now;

  update(deltaTime, time);
  fpsCounter.update(deltaTime);
  renderer.render(gameState);

  requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);

async function importModelFiles(files) {
  renderer.clearModel();
  modelInfoPanel.clear();

  let file;

  try {
    file = pickSingleModelFile(files);
  } catch (error) {
    importStatus.setError(error.message);
    return;
  }

  importStatus.setLoading(file.name);

  try {
    const model = await loadGltfModelFromFile(file);

    renderer.setModel(model);
    modelInfoPanel.setModelInfo(createModelInfo(file.name, model));
    importStatus.setLoaded(file.name);
  } catch (error) {
    console.error(error);
    importStatus.setError(error.message);
  }
}

function loadStoredColor(key, fallback) {
  try {
    return normalizeHexColor(localStorage.getItem(key), fallback);
  } catch {
    return fallback;
  }
}

function loadInitialHudCollapsed() {
  try {
    const storedValue = localStorage.getItem(STORAGE_KEYS.hudCollapsed);

    if (storedValue !== null) {
      return storedValue === "true";
    }
  } catch {
    // Use the viewport default when storage is unavailable.
  }

  return window.matchMedia("(max-width: 640px)").matches;
}

function saveHudCollapsed(value) {
  try {
    localStorage.setItem(STORAGE_KEYS.hudCollapsed, String(value));
  } catch {
    // Rendering should continue even when storage is unavailable.
  }
}

function saveRenderColor(key, value) {
  const storageKey = STORAGE_KEYS[key];
  const fallback = COLOR_FALLBACKS[key];

  if (!storageKey || !fallback) {
    return;
  }

  try {
    localStorage.setItem(storageKey, normalizeHexColor(value, fallback));
  } catch {
    // Rendering should continue even when storage is unavailable.
  }
}
