const FPS_UPDATE_INTERVAL = 0.25;

const CONTROL_ITEMS = [
  ["surfaceVisible", "面"],
  ["wireframeVisible", "ワイヤー"],
  ["useVertexColors", "頂点色"],
  ["lightingEnabled", "ライト"],
  ["gridVisible", "グリッド"],
  ["axesVisible", "軸"],
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
