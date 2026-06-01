import { createFpsCounter } from "./hud.js";
import { createRenderer } from "./renderer.js";

const canvas = document.querySelector("#gl-canvas");

if (!canvas) {
  throw new Error("Canvas element #gl-canvas was not found.");
}

const renderer = createRenderer(canvas);
const fpsCounter = createFpsCounter(document.querySelector("#fps-counter"));

const gameState = {
  time: 0,
  deltaTime: 0,
};

let lastFrameTime = null;

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
