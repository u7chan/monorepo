import {
  makeLookAtMatrix,
  makeOrthographicMatrix,
  multiplyMatrices,
} from "./math.js";
import { fitModelToGround } from "./gltf.js";
import { hexColorToRgb } from "./colors.js";
import { shaderSources } from "./shaders.js";
import { FLOATS_PER_VERTEX } from "./vertex-layout.js";
import { createGeometry, createProgram, resizeCanvasToDisplaySize } from "./webgl.js";

const STRIDE = FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
const COLOR_MODE_VERTEX = 0;
const COLOR_MODE_MATERIAL = 1;
const COLOR_MODE_SOLID = 2;
const CAMERA_INITIAL_TARGET = [0, 0, 0];
const CAMERA_RADIUS = Math.hypot(1.6, 1.6, 1.6);
const CAMERA_ROTATION_SPEED = 0.006;
const CAMERA_ZOOM_SPEED = 0.001;
const CAMERA_MIN_VIEW_SCALE = 0.45;
const CAMERA_MAX_VIEW_SCALE = 2.2;
const CAMERA_MIN_PITCH = -Math.PI / 2 + 0.08;
const CAMERA_MAX_PITCH = Math.PI / 2 - 0.08;
const AXIS_LENGTH = 0.9;
const GRID_DIVISIONS = 3;
const GRID_SPACING = 0.3;
const GRID_COLOR = [0.34, 0.38, 0.43];
const MODEL_TARGET_HEIGHT = AXIS_LENGTH;
const UP_NORMAL = [0, 1, 0];

const axisVertices = createAxisVertices();
const xzGridVertices = createXzGridVertices();

export function createRenderer(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: true });

  if (!gl) {
    throw new Error("WebGL2 is not supported by this browser.");
  }

  const program = createProgram(gl, shaderSources.vertex, shaderSources.fragment);
  const attributes = getAttributes(gl, program);
  const uniforms = getUniforms(gl, program);
  const xzGrid = createDrawable(gl, xzGridVertices, attributes);
  const axes = createDrawable(gl, axisVertices, attributes);
  const camera = createOrbitCamera(canvas);
  let sourceModel = null;
  let currentModel = null;
  let currentAutoFitModel = null;

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);

  return {
    render({ renderOptions }) {
      syncCurrentModel(renderOptions);
      const matrix = prepareFrame(
        gl,
        canvas,
        camera.getEye(),
        camera.getTarget(),
        camera.getViewScale(),
        renderOptions.backgroundColor,
      );

      gl.useProgram(program);
      gl.uniformMatrix4fv(uniforms.matrix, false, matrix);
      gl.uniform1i(
        uniforms.colorMode,
        renderOptions.useVertexColors ? COLOR_MODE_VERTEX : COLOR_MODE_MATERIAL,
      );
      gl.uniform1i(uniforms.lightingEnabled, renderOptions.lightingEnabled ? 1 : 0);

      if (renderOptions.gridVisible) {
        drawLines(gl, xzGrid);
      }

      if (renderOptions.axesVisible) {
        drawLines(gl, axes, 2);
      }

      drawModel(gl, currentModel, renderOptions, uniforms);
    },
    clearModel() {
      sourceModel = null;
      replaceCurrentModel(null);
    },
    setModel(model, renderOptions = {}) {
      sourceModel = model;
      replaceCurrentModel(model, Boolean(renderOptions.autoFitModel));
      camera.reset();
    },
  };

  function replaceCurrentModel(model, autoFitModel = false) {
    disposeModel(gl, currentModel);
    currentModel = model === null ? null : createRenderModel(gl, attributes, model, autoFitModel);
    currentAutoFitModel = model === null ? null : autoFitModel;
  }

  function syncCurrentModel(renderOptions) {
    if (sourceModel === null) {
      return;
    }

    const autoFitModel = Boolean(renderOptions.autoFitModel);

    if (currentAutoFitModel !== autoFitModel) {
      replaceCurrentModel(sourceModel, autoFitModel);
    }
  }
}

export function createOrbitCamera(canvas) {
  const target = [...CAMERA_INITIAL_TARGET];
  let yaw = Math.atan2(1.6, 1.6);
  let pitch = Math.atan2(1.6, Math.hypot(1.6, 1.6));
  let viewScale = 1;
  let dragMode = null;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let lastPinchDistance = null;
  const touchPointers = new Map();

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.button !== 1) {
      return;
    }

    event.preventDefault();
    if (event.pointerType === "touch") {
      touchPointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });

      if (touchPointers.size >= 2) {
        dragMode = null;
        lastPinchDistance = getTouchPointerDistance(touchPointers);
      } else {
        dragMode = "orbit";
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
      }

      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add("is-dragging");
      return;
    }

    dragMode = event.button === 0 ? "orbit" : "pan";
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("is-dragging");
  });

  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") {
      if (!touchPointers.has(event.pointerId)) {
        return;
      }

      event.preventDefault();
      touchPointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });

      if (touchPointers.size >= 2) {
        const pinchDistance = getTouchPointerDistance(touchPointers);

        if (lastPinchDistance !== null && pinchDistance > 0) {
          viewScale = clamp(
            viewScale * (lastPinchDistance / pinchDistance),
            CAMERA_MIN_VIEW_SCALE,
            CAMERA_MAX_VIEW_SCALE,
          );
        }

        lastPinchDistance = pinchDistance;
        dragMode = null;
        return;
      }
    }

    if (dragMode === null) {
      return;
    }

    const deltaX = event.clientX - lastPointerX;
    const deltaY = event.clientY - lastPointerY;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;

    if (dragMode === "orbit") {
      yaw += deltaX * CAMERA_ROTATION_SPEED;
      pitch = clamp(
        pitch + deltaY * CAMERA_ROTATION_SPEED,
        CAMERA_MIN_PITCH,
        CAMERA_MAX_PITCH,
      );
      return;
    }

    panCameraTarget(target, getEyeOffset(yaw, pitch), viewScale, canvas, deltaX, deltaY);
  });

  function stopDragging(event) {
    if (event.pointerType === "touch") {
      touchPointers.delete(event.pointerId);

      if (touchPointers.size >= 2) {
        lastPinchDistance = getTouchPointerDistance(touchPointers);
        dragMode = null;
      } else if (touchPointers.size === 1) {
        const remainingPointer = touchPointers.values().next().value;
        lastPinchDistance = null;
        dragMode = "orbit";
        lastPointerX = remainingPointer.x;
        lastPointerY = remainingPointer.y;
      } else {
        lastPinchDistance = null;
        dragMode = null;
        canvas.classList.remove("is-dragging");
      }

      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      return;
    }

    if (dragMode === null) {
      return;
    }

    dragMode = null;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    canvas.classList.remove("is-dragging");
  }

  canvas.addEventListener("pointerup", stopDragging);
  canvas.addEventListener("pointercancel", stopDragging);
  canvas.addEventListener("lostpointercapture", stopDragging);
  canvas.addEventListener("auxclick", (event) => {
    if (event.button === 1) {
      event.preventDefault();
    }
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      viewScale = clamp(
        viewScale + event.deltaY * CAMERA_ZOOM_SPEED,
        CAMERA_MIN_VIEW_SCALE,
        CAMERA_MAX_VIEW_SCALE,
      );
    },
    { passive: false },
  );

  return {
    getEye() {
      const offset = getEyeOffset(yaw, pitch);

      return [
        target[0] + offset[0],
        target[1] + offset[1],
        target[2] + offset[2],
      ];
    },
    getTarget() {
      return target;
    },
    getViewScale() {
      return viewScale;
    },
    reset() {
      target[0] = CAMERA_INITIAL_TARGET[0];
      target[1] = CAMERA_INITIAL_TARGET[1];
      target[2] = CAMERA_INITIAL_TARGET[2];
      yaw = Math.atan2(1.6, 1.6);
      pitch = Math.atan2(1.6, Math.hypot(1.6, 1.6));
      viewScale = 1;
    },
  };
}

function getTouchPointerDistance(touchPointers) {
  const [firstPointer, secondPointer] = touchPointers.values();
  const deltaX = secondPointer.x - firstPointer.x;
  const deltaY = secondPointer.y - firstPointer.y;

  return Math.hypot(deltaX, deltaY);
}

function getEyeOffset(yaw, pitch) {
  const xzRadius = Math.cos(pitch) * CAMERA_RADIUS;

  return [
    Math.cos(yaw) * xzRadius,
    Math.sin(pitch) * CAMERA_RADIUS,
    Math.sin(yaw) * xzRadius,
  ];
}

function panCameraTarget(target, eyeOffset, viewScale, canvas, deltaX, deltaY) {
  const unitsPerPixel = (viewScale * 2) / Math.max(canvas.clientHeight, 1);
  const zAxis = normalize(eyeOffset);
  const xAxis = normalize(cross([0, 1, 0], zAxis));
  const yAxis = cross(zAxis, xAxis);

  target[0] += (-xAxis[0] * deltaX + yAxis[0] * deltaY) * unitsPerPixel;
  target[1] += (-xAxis[1] * deltaX + yAxis[1] * deltaY) * unitsPerPixel;
  target[2] += (-xAxis[2] * deltaX + yAxis[2] * deltaY) * unitsPerPixel;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function createXzGridVertices() {
  const extent = GRID_DIVISIONS * GRID_SPACING;
  const vertices = [];

  for (let index = -GRID_DIVISIONS; index <= GRID_DIVISIONS; index += 1) {
    const offset = index * GRID_SPACING;

    if (index === 0) {
      pushLine(vertices, [-extent, 0.0, 0.0], [0.0, 0.0, 0.0], GRID_COLOR);
      pushLine(vertices, [0.0, 0.0, -extent], [0.0, 0.0, 0.0], GRID_COLOR);
      continue;
    }

    pushLine(vertices, [-extent, 0.0, offset], [extent, 0.0, offset], GRID_COLOR);
    pushLine(vertices, [offset, 0.0, -extent], [offset, 0.0, extent], GRID_COLOR);
  }

  return new Float32Array(vertices);
}

function createAxisVertices() {
  const vertices = [];

  pushLine(vertices, [0.0, 0.0, 0.0], [AXIS_LENGTH, 0.0, 0.0], [1.0, 0.18, 0.18]);
  pushLine(vertices, [0.0, 0.0, 0.0], [0.0, AXIS_LENGTH, 0.0], [0.24, 0.9, 0.35]);
  pushLine(vertices, [0.0, 0.0, 0.0], [0.0, 0.0, AXIS_LENGTH], [0.28, 0.55, 1.0]);

  return new Float32Array(vertices);
}

function pushLine(vertices, start, end, color) {
  pushPackedVertex(vertices, start, UP_NORMAL, color, color);
  pushPackedVertex(vertices, end, UP_NORMAL, color, color);
}

function pushPackedVertex(vertices, position, normal, vertexColor, materialColor) {
  vertices.push(
    position[0],
    position[1],
    position[2],
    normal[0],
    normal[1],
    normal[2],
    vertexColor[0],
    vertexColor[1],
    vertexColor[2],
    materialColor[0],
    materialColor[1],
    materialColor[2],
  );
}

function getAttributes(gl, program) {
  return {
    position: gl.getAttribLocation(program, "a_position"),
    normal: gl.getAttribLocation(program, "a_normal"),
    vertexColor: gl.getAttribLocation(program, "a_vertex_color"),
    materialColor: gl.getAttribLocation(program, "a_material_color"),
  };
}

function getUniforms(gl, program) {
  return {
    matrix: gl.getUniformLocation(program, "u_matrix"),
    colorMode: gl.getUniformLocation(program, "u_color_mode"),
    solidColor: gl.getUniformLocation(program, "u_solid_color"),
    lightingEnabled: gl.getUniformLocation(program, "u_lighting_enabled"),
  };
}

function createDrawable(gl, vertices, attributes) {
  const geometry = createGeometry(gl, vertices);

  bindGeometry(gl, geometry, attributes);

  return {
    ...geometry,
    vertexCount: vertices.length / FLOATS_PER_VERTEX,
  };
}

function createRenderModel(gl, attributes, model, autoFitModel) {
  const renderModel = autoFitModel ? fitModelToGround(model, MODEL_TARGET_HEIGHT) : model;

  return {
    primitives: renderModel.primitives.map((primitive) => ({
      surface: createDrawable(gl, primitive.triangles, attributes),
      wireframe: createDrawable(gl, primitive.wireframe, attributes),
    })),
  };
}

function disposeModel(gl, model) {
  if (!model) {
    return;
  }

  for (const primitive of model.primitives) {
    disposeDrawable(gl, primitive.surface);
    disposeDrawable(gl, primitive.wireframe);
  }
}

function disposeDrawable(gl, drawable) {
  gl.deleteVertexArray(drawable.vao);
  gl.deleteBuffer(drawable.buffer);
}

function bindGeometry(gl, geometry, attributes) {
  gl.bindVertexArray(geometry.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, geometry.buffer);

  gl.enableVertexAttribArray(attributes.position);
  gl.vertexAttribPointer(attributes.position, 3, gl.FLOAT, false, STRIDE, 0);

  gl.enableVertexAttribArray(attributes.normal);
  gl.vertexAttribPointer(
    attributes.normal,
    3,
    gl.FLOAT,
    false,
    STRIDE,
    3 * Float32Array.BYTES_PER_ELEMENT,
  );

  gl.enableVertexAttribArray(attributes.vertexColor);
  gl.vertexAttribPointer(
    attributes.vertexColor,
    3,
    gl.FLOAT,
    false,
    STRIDE,
    6 * Float32Array.BYTES_PER_ELEMENT,
  );

  gl.enableVertexAttribArray(attributes.materialColor);
  gl.vertexAttribPointer(
    attributes.materialColor,
    3,
    gl.FLOAT,
    false,
    STRIDE,
    9 * Float32Array.BYTES_PER_ELEMENT,
  );

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
}

function prepareFrame(gl, canvas, cameraEye, cameraTarget, viewScale, backgroundColor) {
  resizeCanvasToDisplaySize(canvas);

  const aspect = canvas.width / canvas.height;
  const projectionMatrix = makeOrthographicMatrix(
    -aspect * viewScale,
    aspect * viewScale,
    -viewScale,
    viewScale,
    0.1,
    10,
  );
  const viewMatrix = makeLookAtMatrix(cameraEye, cameraTarget, [0, 1, 0]);

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(...hexColorToRgb(backgroundColor), 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  return multiplyMatrices(projectionMatrix, viewMatrix);
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);

  if (length === 0) {
    return [0, 0, 0];
  }

  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function drawModel(gl, model, renderOptions, uniforms) {
  if (!model) {
    return;
  }

  if (renderOptions.surfaceVisible) {
    gl.uniform1i(
      uniforms.colorMode,
      renderOptions.useVertexColors ? COLOR_MODE_VERTEX : COLOR_MODE_MATERIAL,
    );
    gl.uniform1i(uniforms.lightingEnabled, renderOptions.lightingEnabled ? 1 : 0);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);

    for (const primitive of model.primitives) {
      gl.bindVertexArray(primitive.surface.vao);
      gl.drawArrays(gl.TRIANGLES, 0, primitive.surface.vertexCount);
    }

    gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  if (renderOptions.wireframeVisible) {
    gl.uniform1i(uniforms.colorMode, COLOR_MODE_SOLID);
    gl.uniform3fv(uniforms.solidColor, hexColorToRgb(renderOptions.wireframeColor));
    gl.uniform1i(uniforms.lightingEnabled, 0);

    for (const primitive of model.primitives) {
      drawLines(gl, primitive.wireframe);
    }
  }

  gl.disable(gl.CULL_FACE);
}

function drawLines(gl, drawable, lineWidth = 1) {
  gl.disable(gl.CULL_FACE);
  gl.bindVertexArray(drawable.vao);
  gl.lineWidth(lineWidth);
  gl.drawArrays(gl.LINES, 0, drawable.vertexCount);
}
