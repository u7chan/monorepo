import {
  makeLookAtMatrix,
  makeOrthographicMatrix,
  multiplyMatrices,
} from "./math.js";
import { shaderSources } from "./shaders.js";
import { createGeometry, createProgram, resizeCanvasToDisplaySize } from "./webgl.js";

const FLOATS_PER_VERTEX = 6;
const STRIDE = FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
const CAMERA_TARGET = [0, 0, 0];
const CAMERA_RADIUS = Math.hypot(1.6, 1.6, 1.6);
const CAMERA_ROTATION_SPEED = 0.008;
const CAMERA_MIN_PITCH = -Math.PI / 2 + 0.08;
const CAMERA_MAX_PITCH = Math.PI / 2 - 0.08;

const triangleVertices = new Float32Array([
  // x, y, z, r, g, b
  -0.48, 0.0, -0.32, 0.95, 0.25, 0.28,
  0.48, 0.0, -0.32, 0.18, 0.72, 0.95,
  0.0, 0.0, 0.42, 1.0, 0.82, 0.28,
]);

const axisVertices = new Float32Array([
  // x axis: red
  -0.9, 0.0, 0.0, 1.0, 0.18, 0.18,
  0.9, 0.0, 0.0, 1.0, 0.18, 0.18,

  // y axis: green
  0.0, -0.9, 0.0, 0.24, 0.9, 0.35,
  0.0, 0.9, 0.0, 0.24, 0.9, 0.35,

  // z axis: blue
  0.0, 0.0, -0.9, 0.28, 0.55, 1.0,
  0.0, 0.0, 0.9, 0.28, 0.55, 1.0,
]);

export function createRenderer(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: true });

  if (!gl) {
    throw new Error("WebGL2 is not supported by this browser.");
  }

  const program = createProgram(gl, shaderSources.vertex, shaderSources.fragment);
  const attributes = getAttributes(gl, program);
  const uniforms = getUniforms(gl, program);
  const triangle = createDrawable(gl, triangleVertices, attributes);
  const axes = createDrawable(gl, axisVertices, attributes);
  const camera = createOrbitCamera(canvas);

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);

  return {
    render({ time }) {
      const matrix = prepareFrame(gl, canvas, camera.getEye());

      gl.useProgram(program);
      gl.uniform1f(uniforms.time, time);
      gl.uniformMatrix4fv(uniforms.matrix, false, matrix);

      drawAxes(gl, axes, uniforms);
      drawTriangle(gl, triangle, uniforms);
    },
  };
}

function createOrbitCamera(canvas) {
  let yaw = Math.atan2(1.6, 1.6);
  let pitch = Math.atan2(1.6, Math.hypot(1.6, 1.6));
  let isDragging = false;
  let lastPointerX = 0;
  let lastPointerY = 0;

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    isDragging = true;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("is-dragging");
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!isDragging) {
      return;
    }

    const deltaX = event.clientX - lastPointerX;
    const deltaY = event.clientY - lastPointerY;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    yaw -= deltaX * CAMERA_ROTATION_SPEED;
    pitch = clamp(
      pitch - deltaY * CAMERA_ROTATION_SPEED,
      CAMERA_MIN_PITCH,
      CAMERA_MAX_PITCH,
    );
  });

  function stopDragging(event) {
    if (!isDragging) {
      return;
    }

    isDragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    canvas.classList.remove("is-dragging");
  }

  canvas.addEventListener("pointerup", stopDragging);
  canvas.addEventListener("pointercancel", stopDragging);
  canvas.addEventListener("lostpointercapture", stopDragging);

  return {
    getEye() {
      const xzRadius = Math.cos(pitch) * CAMERA_RADIUS;

      return [
        Math.cos(yaw) * xzRadius,
        Math.sin(pitch) * CAMERA_RADIUS,
        Math.sin(yaw) * xzRadius,
      ];
    },
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getAttributes(gl, program) {
  return {
    position: gl.getAttribLocation(program, "a_position"),
    color: gl.getAttribLocation(program, "a_color"),
  };
}

function getUniforms(gl, program) {
  return {
    time: gl.getUniformLocation(program, "u_time"),
    matrix: gl.getUniformLocation(program, "u_matrix"),
    waveStrength: gl.getUniformLocation(program, "u_wave_strength"),
    pulseStrength: gl.getUniformLocation(program, "u_pulse_strength"),
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

function bindGeometry(gl, geometry, attributes) {
  gl.bindVertexArray(geometry.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, geometry.buffer);

  gl.enableVertexAttribArray(attributes.position);
  gl.vertexAttribPointer(attributes.position, 3, gl.FLOAT, false, STRIDE, 0);

  gl.enableVertexAttribArray(attributes.color);
  gl.vertexAttribPointer(
    attributes.color,
    3,
    gl.FLOAT,
    false,
    STRIDE,
    3 * Float32Array.BYTES_PER_ELEMENT,
  );

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
}

function prepareFrame(gl, canvas, cameraEye) {
  resizeCanvasToDisplaySize(canvas);

  const aspect = canvas.width / canvas.height;
  const projectionMatrix = makeOrthographicMatrix(-aspect, aspect, -1, 1, 0.1, 10);
  const viewMatrix = makeLookAtMatrix(cameraEye, CAMERA_TARGET, [0, 1, 0]);

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.06, 0.07, 0.08, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  return multiplyMatrices(projectionMatrix, viewMatrix);
}

function drawAxes(gl, axes, uniforms) {
  gl.bindVertexArray(axes.vao);
  gl.uniform1f(uniforms.waveStrength, 0.0);
  gl.uniform1f(uniforms.pulseStrength, 0.0);
  gl.lineWidth(2);
  gl.drawArrays(gl.LINES, 0, axes.vertexCount);
}

function drawTriangle(gl, triangle, uniforms) {
  gl.bindVertexArray(triangle.vao);
  gl.uniform1f(uniforms.waveStrength, 0.08);
  gl.uniform1f(uniforms.pulseStrength, 1.0);
  gl.drawArrays(gl.TRIANGLES, 0, triangle.vertexCount);
}
