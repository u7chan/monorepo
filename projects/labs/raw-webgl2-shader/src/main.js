import { createModelDropImporter, pickSingleModelFile } from "./drop-import.js";
import { loadGltfModelFromFile } from "./gltf.js";
import {
  createColorControls,
  createFpsCounter,
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
  wireframeColor: "raw-webgl2.wireframeColor",
};

if (!canvas) {
  throw new Error("Canvas element #gl-canvas was not found.");
}

const renderer = createRenderer(canvas);
const fpsCounter = createFpsCounter(document.querySelector("#fps-counter"));
const importStatus = createImportStatus(document.querySelector("#import-status"));
const modelInfoPanel = createModelInfoPanel(document.querySelector("#model-info"));

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

createModelDropImporter({
  onDragChange(isDragging) {
    canvas.classList.toggle("is-drop-target", isDragging);
    document.body.classList.toggle("is-dropping-model", isDragging);
    importStatus.setDragging(isDragging);
  },
  async onDropFiles(files) {
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
  },
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

function loadStoredColor(key, fallback) {
  try {
    return normalizeHexColor(localStorage.getItem(key), fallback);
  } catch {
    return fallback;
  }
}

function saveRenderColor(key, value) {
  try {
    localStorage.setItem(STORAGE_KEYS[key], normalizeHexColor(value, value));
  } catch {
    // Rendering should continue even when storage is unavailable.
  }
}
