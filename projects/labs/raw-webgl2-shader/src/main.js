"use strict";

const canvas = document.querySelector("#gl-canvas");
const gl = canvas.getContext("webgl2", { antialias: true });

if (!gl) {
  throw new Error("WebGL2 is not supported by this browser.");
}

const vertices = new Float32Array([
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

const { vertex, fragment } = window.shaderSources;
const program = createProgram(gl, vertex, fragment);
const triangle = createGeometry(gl, vertices);
const axes = createGeometry(gl, axisVertices);

const positionLocation = gl.getAttribLocation(program, "a_position");
const colorLocation = gl.getAttribLocation(program, "a_color");
const timeLocation = gl.getUniformLocation(program, "u_time");
const matrixLocation = gl.getUniformLocation(program, "u_matrix");
const waveStrengthLocation = gl.getUniformLocation(program, "u_wave_strength");
const pulseStrengthLocation = gl.getUniformLocation(program, "u_pulse_strength");
const stride = 6 * Float32Array.BYTES_PER_ELEMENT;

bindGeometry(gl, triangle, positionLocation, colorLocation);
bindGeometry(gl, axes, positionLocation, colorLocation);

const triangleVertexCount = vertices.length / 6;
const axisVertexCount = axisVertices.length / 6;

gl.enable(gl.DEPTH_TEST);
gl.depthFunc(gl.LEQUAL);

function render(now) {
  const time = now * 0.001;

  resizeCanvasToDisplaySize(canvas);
  const aspect = canvas.width / canvas.height;
  const projectionMatrix = makeOrthographicMatrix(-aspect, aspect, -1, 1, 0.1, 10);
  const viewMatrix = makeLookAtMatrix([1.6, 1.6, 1.6], [0, 0, 0], [0, 1, 0]);
  const matrix = multiplyMatrices(projectionMatrix, viewMatrix);

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.06, 0.07, 0.08, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  gl.useProgram(program);
  gl.uniform1f(timeLocation, time);
  gl.uniformMatrix4fv(matrixLocation, false, matrix);

  gl.bindVertexArray(axes.vao);
  gl.uniform1f(waveStrengthLocation, 0.0);
  gl.uniform1f(pulseStrengthLocation, 0.0);
  gl.lineWidth(2);
  gl.drawArrays(gl.LINES, 0, axisVertexCount);

  gl.bindVertexArray(triangle.vao);
  gl.uniform1f(waveStrengthLocation, 0.08);
  gl.uniform1f(pulseStrengthLocation, 1.0);
  gl.drawArrays(gl.TRIANGLES, 0, triangleVertexCount);

  requestAnimationFrame(render);
}

requestAnimationFrame(render);

function createProgram(glContext, vertexSource, fragmentSource) {
  const vertexShader = compileShader(glContext, glContext.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(
    glContext,
    glContext.FRAGMENT_SHADER,
    fragmentSource,
  );
  const shaderProgram = glContext.createProgram();

  glContext.attachShader(shaderProgram, vertexShader);
  glContext.attachShader(shaderProgram, fragmentShader);
  glContext.linkProgram(shaderProgram);

  if (!glContext.getProgramParameter(shaderProgram, glContext.LINK_STATUS)) {
    const info = glContext.getProgramInfoLog(shaderProgram);
    glContext.deleteProgram(shaderProgram);
    throw new Error(`Program link failed:\n${info}`);
  }

  glContext.deleteShader(vertexShader);
  glContext.deleteShader(fragmentShader);

  return shaderProgram;
}

function compileShader(glContext, type, source) {
  const shader = glContext.createShader(type);

  glContext.shaderSource(shader, source);
  glContext.compileShader(shader);

  if (!glContext.getShaderParameter(shader, glContext.COMPILE_STATUS)) {
    const info = glContext.getShaderInfoLog(shader);
    glContext.deleteShader(shader);
    throw new Error(`Shader compile failed:\n${info}`);
  }

  return shader;
}

function createGeometry(glContext, data) {
  const vao = glContext.createVertexArray();
  const buffer = glContext.createBuffer();

  glContext.bindVertexArray(vao);
  glContext.bindBuffer(glContext.ARRAY_BUFFER, buffer);
  glContext.bufferData(glContext.ARRAY_BUFFER, data, glContext.STATIC_DRAW);
  glContext.bindVertexArray(null);
  glContext.bindBuffer(glContext.ARRAY_BUFFER, null);

  return { vao, buffer };
}

function bindGeometry(glContext, geometry, positionLocation, colorLocation) {
  glContext.bindVertexArray(geometry.vao);
  glContext.bindBuffer(glContext.ARRAY_BUFFER, geometry.buffer);

  glContext.enableVertexAttribArray(positionLocation);
  glContext.vertexAttribPointer(positionLocation, 3, glContext.FLOAT, false, stride, 0);

  glContext.enableVertexAttribArray(colorLocation);
  glContext.vertexAttribPointer(
    colorLocation,
    3,
    glContext.FLOAT,
    false,
    stride,
    3 * Float32Array.BYTES_PER_ELEMENT,
  );

  glContext.bindVertexArray(null);
  glContext.bindBuffer(glContext.ARRAY_BUFFER, null);
}

function makeOrthographicMatrix(left, right, bottom, top, near, far) {
  return new Float32Array([
    2 / (right - left),
    0,
    0,
    0,
    0,
    2 / (top - bottom),
    0,
    0,
    0,
    0,
    2 / (near - far),
    0,
    (left + right) / (left - right),
    (bottom + top) / (bottom - top),
    (near + far) / (near - far),
    1,
  ]);
}

function makeLookAtMatrix(eye, target, up) {
  const zAxis = normalize(subtractVectors(eye, target));
  const xAxis = normalize(cross(up, zAxis));
  const yAxis = cross(zAxis, xAxis);

  return new Float32Array([
    xAxis[0],
    yAxis[0],
    zAxis[0],
    0,
    xAxis[1],
    yAxis[1],
    zAxis[1],
    0,
    xAxis[2],
    yAxis[2],
    zAxis[2],
    0,
    -dot(xAxis, eye),
    -dot(yAxis, eye),
    -dot(zAxis, eye),
    1,
  ]);
}

function multiplyMatrices(a, b) {
  const result = new Float32Array(16);

  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      result[column * 4 + row] =
        a[row] * b[column * 4] +
        a[4 + row] * b[column * 4 + 1] +
        a[8 + row] * b[column * 4 + 2] +
        a[12 + row] * b[column * 4 + 3];
    }
  }

  return result;
}

function subtractVectors(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
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

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function resizeCanvasToDisplaySize(targetCanvas) {
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.floor(targetCanvas.clientWidth * pixelRatio);
  const height = Math.floor(targetCanvas.clientHeight * pixelRatio);

  if (targetCanvas.width !== width || targetCanvas.height !== height) {
    targetCanvas.width = width;
    targetCanvas.height = height;
  }
}
