import { createGltfDropImporter, pickSingleGltfFile } from "./drop-import.js";
import { loadGltfModelFromFile } from "./gltf.js";
import { createFpsCounter, createImportStatus, createRenderControls } from "./hud.js";
import { createRenderer } from "./renderer.js";

const canvas = document.querySelector("#gl-canvas");

if (!canvas) {
  throw new Error("Canvas element #gl-canvas was not found.");
}

const renderer = createRenderer(canvas);
const fpsCounter = createFpsCounter(document.querySelector("#fps-counter"));
const importStatus = createImportStatus(document.querySelector("#import-status"));

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
  },
};

let lastFrameTime = null;

createRenderControls(
  document.querySelector("#render-controls"),
  gameState.renderOptions,
);

createGltfDropImporter({
  onDragChange(isDragging) {
    canvas.classList.toggle("is-drop-target", isDragging);
    document.body.classList.toggle("is-dropping-gltf", isDragging);
    importStatus.setDragging(isDragging);
  },
  async onDropFiles(files) {
    renderer.clearModel();

    let file;

    try {
      file = pickSingleGltfFile(files);
    } catch (error) {
      importStatus.setError(error.message);
      return;
    }

    importStatus.setLoading(file.name);

    try {
      const model = await loadGltfModelFromFile(file);

      renderer.setModel(model);
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
