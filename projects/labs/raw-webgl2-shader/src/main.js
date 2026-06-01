"use strict";

const canvas = document.querySelector("#gl-canvas");
const gl = canvas.getContext("webgl2", { antialias: true });

if (!gl) {
  throw new Error("WebGL2 is not supported by this browser.");
}

const vertices = new Float32Array([
  // x, y, z, r, g, b
  -0.7, -0.55, 0.0, 0.95, 0.25, 0.28,
  0.7, -0.55, 0.0, 0.18, 0.72, 0.95,
  0.0, 0.65, 0.0, 1.0, 0.82, 0.28,
]);

const { vertex, fragment } = window.shaderSources;
const program = createProgram(gl, vertex, fragment);
const vao = gl.createVertexArray();
const vertexBuffer = gl.createBuffer();

const positionLocation = gl.getAttribLocation(program, "a_position");
const colorLocation = gl.getAttribLocation(program, "a_color");
const timeLocation = gl.getUniformLocation(program, "u_time");
const resolutionLocation = gl.getUniformLocation(program, "u_resolution");

gl.bindVertexArray(vao);
gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

const stride = 6 * Float32Array.BYTES_PER_ELEMENT;

gl.enableVertexAttribArray(positionLocation);
gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, stride, 0);

gl.enableVertexAttribArray(colorLocation);
gl.vertexAttribPointer(
  colorLocation,
  3,
  gl.FLOAT,
  false,
  stride,
  3 * Float32Array.BYTES_PER_ELEMENT,
);

gl.bindVertexArray(null);
gl.bindBuffer(gl.ARRAY_BUFFER, null);

function render(now) {
  const time = now * 0.001;

  resizeCanvasToDisplaySize(canvas);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.06, 0.07, 0.08, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(program);
  gl.bindVertexArray(vao);
  gl.uniform1f(timeLocation, time);
  gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

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

function resizeCanvasToDisplaySize(targetCanvas) {
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.floor(targetCanvas.clientWidth * pixelRatio);
  const height = Math.floor(targetCanvas.clientHeight * pixelRatio);

  if (targetCanvas.width !== width || targetCanvas.height !== height) {
    targetCanvas.width = width;
    targetCanvas.height = height;
  }
}
