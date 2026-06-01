const FPS_UPDATE_INTERVAL = 0.25;

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
