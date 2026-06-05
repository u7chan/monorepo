import { afterEach, describe, expect, test } from "bun:test";
import { createOrbitCamera, createRenderer } from "../src/renderer.js";

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = originalWindow;
  }
});

describe("createOrbitCamera", () => {
  test("2本指のピンチアウトで拡大する", () => {
    const canvas = createTestCanvas();
    const camera = createOrbitCamera(canvas);

    dispatchPointer(canvas, "pointerdown", {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    dispatchPointer(canvas, "pointerdown", {
      clientX: 0,
      clientY: 100,
      pointerId: 2,
    });
    dispatchPointer(canvas, "pointermove", {
      clientX: 0,
      clientY: 200,
      pointerId: 2,
    });

    expect(camera.getViewScale()).toBe(0.5);
  });

  test("2本指のピンチインで縮小する", () => {
    const canvas = createTestCanvas();
    const camera = createOrbitCamera(canvas);

    dispatchPointer(canvas, "pointerdown", {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    dispatchPointer(canvas, "pointerdown", {
      clientX: 0,
      clientY: 200,
      pointerId: 2,
    });
    dispatchPointer(canvas, "pointermove", {
      clientX: 0,
      clientY: 100,
      pointerId: 2,
    });

    expect(camera.getViewScale()).toBe(2);
  });

  test("1本指では既存どおり回転する", () => {
    const canvas = createTestCanvas();
    const camera = createOrbitCamera(canvas);
    const initialEye = camera.getEye();

    dispatchPointer(canvas, "pointerdown", {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    dispatchPointer(canvas, "pointermove", {
      clientX: 40,
      clientY: 0,
      pointerId: 1,
    });

    expect(camera.getEye()).not.toEqual(initialEye);
  });
});

describe("createRenderer texture rendering", () => {
  test("baseColorTexture付きprimitiveをtexture drawしclearでresourceを破棄する", () => {
    const gl = createMockGl();
    const canvas = createTestCanvas(gl);
    const bitmap = {
      closed: false,
      close() {
        this.closed = true;
      },
    };
    const model = createTexturedModel(bitmap);
    const renderer = createRenderer(canvas);

    renderer.setModel(model);
    renderer.render({ renderOptions: createRenderOptions() });

    expect(gl.bufferDataCalls.some((call) => call.data === model.primitives[0].texcoords)).toBe(true);
    expect(gl.vertexAttribPointerCalls.some((call) => call.index === 4 && call.size === 2)).toBe(true);
    expect(gl.texParameteriCalls).toEqual([
      [gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT],
      [gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT],
      [gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    ]);
    expect(gl.texImage2DCalls[0].source).toBe(bitmap);
    expect(gl.uniform1iCalls).toContainEqual(["u_color_mode", 1]);
    expect(gl.uniform1iCalls).toContainEqual(["u_texture_enabled", 1]);
    expect(gl.drawArraysCalls).toContainEqual([gl.TRIANGLES, 0, 3]);

    renderer.clearModel();

    expect(gl.deletedTextures).toEqual(["texture-0"]);
    expect(bitmap.closed).toBe(true);
  });

  test("UVなしprimitiveはtextureを使わずmaterial色へfallbackする", () => {
    const gl = createMockGl();
    const canvas = createTestCanvas(gl);
    const model = createTexturedModel({ close() {} });

    model.primitives[0].texcoords = null;

    const renderer = createRenderer(canvas);

    renderer.setModel(model);
    renderer.render({ renderOptions: createRenderOptions() });

    expect(gl.uniform1iCalls).not.toContainEqual(["u_texture_enabled", 1]);
    expect(gl.drawArraysCalls).toContainEqual([gl.TRIANGLES, 0, 3]);
  });

  test("texcoordIndexが0以外のtextureは使わずmaterial色へfallbackする", () => {
    const gl = createMockGl();
    const canvas = createTestCanvas(gl);
    const model = createTexturedModel({ close() {} });

    model.materials[0].baseColorTexture.texcoordIndex = 1;

    const renderer = createRenderer(canvas);

    renderer.setModel(model);
    renderer.render({ renderOptions: createRenderOptions() });

    expect(gl.uniform1iCalls).not.toContainEqual(["u_texture_enabled", 1]);
    expect(gl.drawArraysCalls).toContainEqual([gl.TRIANGLES, 0, 3]);
  });

  test("mipmap系minFilterではmipmapを生成する", () => {
    const gl = createMockGl();
    const canvas = createTestCanvas(gl);
    const model = createTexturedModel(
      { close() {} },
      { minFilter: gl.LINEAR_MIPMAP_LINEAR },
    );
    const renderer = createRenderer(canvas);

    renderer.setModel(model);

    expect(gl.generateMipmapCalls).toEqual([gl.TEXTURE_2D]);
  });
});

function createTestCanvas(gl = null) {
  const captures = new Set();

  return Object.assign(new EventTarget(), {
    clientWidth: 640,
    clientHeight: 1000,
    height: 1000,
    width: 640,
    classList: {
      add() {},
      remove() {},
    },
    getContext(type) {
      return type === "webgl2" ? gl : null;
    },
    hasPointerCapture(pointerId) {
      return captures.has(pointerId);
    },
    releasePointerCapture(pointerId) {
      captures.delete(pointerId);
    },
    setPointerCapture(pointerId) {
      captures.add(pointerId);
    },
  });
}

function dispatchPointer(canvas, type, options) {
  const event = new Event(type, { cancelable: true });

  Object.assign(event, {
    button: 0,
    clientX: options.clientX,
    clientY: options.clientY,
    pointerId: options.pointerId,
    pointerType: "touch",
  });
  canvas.dispatchEvent(event);

  return event;
}

function createRenderOptions() {
  globalThis.window = { devicePixelRatio: 1 };

  return {
    axesVisible: false,
    autoFitModel: false,
    backgroundColor: "#000000",
    gridVisible: false,
    lightingEnabled: false,
    surfaceVisible: true,
    useVertexColors: true,
    wireframeColor: "#ffffff",
    wireframeVisible: false,
  };
}

function createTexturedModel(bitmap, samplerOverrides = {}) {
  return {
    bounds: {
      min: [0, 0, 0],
      max: [1, 1, 0],
    },
    images: [bitmap],
    materials: [
      {
        baseColor: [0.5, 0.6, 0.7],
        baseColorFactor: [0.5, 0.6, 0.7, 1],
        baseColorTexture: {
          imageIndex: 0,
          texcoordIndex: 0,
          textureIndex: 0,
        },
        index: 0,
        name: "Textured",
      },
    ],
    primitives: [
      {
        materialIndex: 0,
        texcoords: new Float32Array([
          0, 0,
          1, 0,
          0, 1,
        ]),
        triangles: new Float32Array(3 * 12),
        wireframe: new Float32Array(0),
      },
    ],
    textures: [
      {
        imageIndex: 0,
        sampler: {
          magFilter: 0x2601,
          minFilter: 0x2601,
          wrapS: 0x2901,
          wrapT: 0x8370,
          ...samplerOverrides,
        },
      },
    ],
  };
}

function createMockGl() {
  let shaderIndex = 0;
  let programIndex = 0;
  let vaoIndex = 0;
  let bufferIndex = 0;
  let textureIndex = 0;
  const gl = {
    ARRAY_BUFFER: 0x8892,
    CLAMP_TO_EDGE: 0x812f,
    COLOR_BUFFER_BIT: 0x4000,
    COMPILE_STATUS: 0x8b81,
    DEPTH_BUFFER_BIT: 0x0100,
    DEPTH_TEST: 0x0b71,
    FLOAT: 0x1406,
    FRAGMENT_SHADER: 0x8b30,
    LEQUAL: 0x0203,
    LINEAR: 0x2601,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    LINK_STATUS: 0x8b82,
    LINES: 0x0001,
    MIRRORED_REPEAT: 0x8370,
    POLYGON_OFFSET_FILL: 0x8037,
    RGBA: 0x1908,
    REPEAT: 0x2901,
    STATIC_DRAW: 0x88e4,
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TRIANGLES: 0x0004,
    UNSIGNED_BYTE: 0x1401,
    VERTEX_SHADER: 0x8b31,
    bufferDataCalls: [],
    deletedTextures: [],
    drawArraysCalls: [],
    generateMipmapCalls: [],
    texImage2DCalls: [],
    texParameteriCalls: [],
    uniform1iCalls: [],
    vertexAttribPointerCalls: [],
    activeTexture() {},
    attachShader() {},
    bindBuffer() {},
    bindTexture() {},
    bindVertexArray() {},
    clear() {},
    clearColor() {},
    compileShader() {},
    createBuffer() {
      const buffer = `buffer-${bufferIndex}`;
      bufferIndex += 1;

      return buffer;
    },
    createProgram() {
      const program = `program-${programIndex}`;
      programIndex += 1;

      return program;
    },
    createShader() {
      const shader = `shader-${shaderIndex}`;
      shaderIndex += 1;

      return shader;
    },
    createTexture() {
      const texture = `texture-${textureIndex}`;
      textureIndex += 1;

      return texture;
    },
    createVertexArray() {
      const vao = `vao-${vaoIndex}`;
      vaoIndex += 1;

      return vao;
    },
    deleteBuffer() {},
    deleteProgram() {},
    deleteShader() {},
    deleteTexture(texture) {
      gl.deletedTextures.push(texture);
    },
    deleteVertexArray() {},
    depthFunc() {},
    disable() {},
    enable() {},
    enableVertexAttribArray() {},
    getAttribLocation(_program, name) {
      return {
        a_position: 0,
        a_normal: 1,
        a_vertex_color: 2,
        a_material_color: 3,
        a_texcoord: 4,
      }[name];
    },
    getProgramInfoLog() {
      return "";
    },
    getProgramParameter() {
      return true;
    },
    getShaderInfoLog() {
      return "";
    },
    getShaderParameter() {
      return true;
    },
    getUniformLocation(_program, name) {
      return name;
    },
    generateMipmap(target) {
      gl.generateMipmapCalls.push(target);
    },
    lineWidth() {},
    linkProgram() {},
    polygonOffset() {},
    shaderSource() {},
    texImage2D(target, level, internalFormat, format, type, source) {
      gl.texImage2DCalls.push({ format, internalFormat, level, source, target, type });
    },
    texParameteri(target, pname, value) {
      gl.texParameteriCalls.push([target, pname, value]);
    },
    uniform1i(location, value) {
      gl.uniform1iCalls.push([location, value]);
    },
    uniform3fv() {},
    uniformMatrix4fv() {},
    useProgram() {},
    vertexAttribPointer(index, size, type, normalized, stride, offset) {
      gl.vertexAttribPointerCalls.push({
        index,
        normalized,
        offset,
        size,
        stride,
        type,
      });
    },
    viewport() {},
    bufferData(target, data, usage) {
      gl.bufferDataCalls.push({ data, target, usage });
    },
    drawArrays(mode, first, count) {
      gl.drawArraysCalls.push([mode, first, count]);
    },
  };

  return gl;
}
