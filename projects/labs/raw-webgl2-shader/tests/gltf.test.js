import { afterEach, describe, expect, test } from "bun:test";
import {
  fitModelToGround,
  loadGltfModel,
  loadGltfModelFromFile,
} from "../src/gltf.js";

const GL_FLOAT = 5126;
const GL_UNSIGNED_SHORT = 5123;
const GL_TRIANGLES = 4;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const PACKED_VERTEX_SIZE = 12;
const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a;
const GLB_BIN_CHUNK_TYPE = 0x004e4942;

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = originalWindow;
  }
});

describe("loadGltfModelFromFile", () => {
  test("埋め込みdata URIの三角形を読み込める", async () => {
    const gltf = createTriangleGltf({
      colors: [
        1, 0, 0, 1,
        0, 1, 0, 1,
        0, 0, 1, 1,
      ],
      materialColor: [0.25, 0.5, 0.75],
      normals: [
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
      ],
    });

    const model = await loadGltfModelFromFile(createGltfFile(gltf));

    expect(model.triangles).toBeInstanceOf(Float32Array);
    expect(model.wireframe).toBeInstanceOf(Float32Array);
    expect(model.triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
    expect(model.wireframe.length).toBe(6 * PACKED_VERTEX_SIZE);
    expectVector(model.bounds.min, [0, 0, 0]);
    expectVector(model.bounds.max, [1, 1, 0]);
    expectVector(readPackedVertex(model.triangles, 0).position, [0, 0, 0]);
    expectVector(readPackedVertex(model.triangles, 0).normal, [0, 0, 1]);
    expectVector(readPackedVertex(model.triangles, 0).color, [1, 0, 0]);
    expectVector(readPackedVertex(model.triangles, 0).materialColor, [0.25, 0.5, 0.75]);
  });

  test("indicesがない場合は頂点順で三角形を作る", async () => {
    const gltf = createTriangleGltf({ indices: null });

    const model = await loadGltfModelFromFile(createGltfFile(gltf));

    expect(model.triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
    expectVector(readPackedVertex(model.triangles, 0).position, [0, 0, 0]);
    expectVector(readPackedVertex(model.triangles, 1).position, [1, 0, 0]);
    expectVector(readPackedVertex(model.triangles, 2).position, [0, 1, 0]);
  });

  test("byteStride付きのaccessorを読める", async () => {
    const positionBuffer = floatBuffer([
      0, 0, 0, 99,
      1, 0, 0, 99,
      0, 1, 0, 99,
    ]);
    const gltf = createTriangleGltf({
      positionBuffer,
      positionByteStride: 16,
      positions: null,
    });

    const model = await loadGltfModelFromFile(createGltfFile(gltf));

    expectVector(readPackedVertex(model.triangles, 2).position, [0, 1, 0]);
    expectVector(model.bounds.max, [1, 1, 0]);
  });

  test("byteOffset付きのaccessorを読める", async () => {
    const positionBuffer = floatBuffer([
      99,
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]);
    const gltf = createTriangleGltf({
      positionBuffer,
      positionByteOffset: 4,
      positions: null,
    });

    const model = await loadGltfModelFromFile(createGltfFile(gltf));

    expectVector(readPackedVertex(model.triangles, 0).position, [0, 0, 0]);
    expectVector(readPackedVertex(model.triangles, 2).position, [0, 1, 0]);
    expectVector(model.bounds.min, [0, 0, 0]);
    expectVector(model.bounds.max, [1, 1, 0]);
  });

  test("nodeのtranslationとscaleを頂点に反映する", async () => {
    const gltf = createTriangleGltf({
      node: {
        mesh: 0,
        scale: [2, 3, 4],
        translation: [10, 20, 30],
      },
    });

    const model = await loadGltfModelFromFile(createGltfFile(gltf));

    expectVector(model.bounds.min, [10, 20, 30]);
    expectVector(model.bounds.max, [12, 23, 30]);
    expectVector(readPackedVertex(model.triangles, 1).position, [12, 20, 30]);
  });

  test("NORMALとCOLOR_0がない場合はデフォルト値とmaterial色を使う", async () => {
    const gltf = createTriangleGltf({
      materialColor: [0.1, 0.2, 0.3],
    });

    const model = await loadGltfModelFromFile(createGltfFile(gltf));
    const vertex = readPackedVertex(model.triangles, 0);

    expectVector(vertex.normal, [0, 1, 0]);
    expectVector(vertex.color, [0.1, 0.2, 0.3]);
    expectVector(vertex.materialColor, [0.1, 0.2, 0.3]);
  });

  test("GLBの三角形を読み込める", async () => {
    const model = await loadGltfModelFromFile(createGlbFile(createTriangleGlb()));

    expect(model.triangles).toBeInstanceOf(Float32Array);
    expect(model.triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
    expect(model.wireframe.length).toBe(6 * PACKED_VERTEX_SIZE);
    expectVector(model.bounds.min, [0, 0, 0]);
    expectVector(model.bounds.max, [1, 1, 0]);
    expectVector(readPackedVertex(model.triangles, 2).position, [0, 1, 0]);
  });

  test("gltf以外のファイル名は拒否する", async () => {
    await expect(loadGltfModelFromFile(createGltfFile({}, "model.obj"))).rejects.toThrow(
      "Only .gltf and .glb files are supported.",
    );
  });

  test("JSONとして壊れているgltfを拒否する", async () => {
    const file = new File(["{"], "model.gltf", { type: "model/gltf+json" });

    await expect(loadGltfModelFromFile(file)).rejects.toThrow(
      "Dropped .gltf is not valid JSON.",
    );
  });

  test("dropされたgltfの外部bin参照を拒否する", async () => {
    const gltf = createTriangleGltf({ externalBufferUri: "mesh.bin" }).gltf;

    await expect(loadGltfModelFromFile(createGltfFile(gltf))).rejects.toThrow(
      "External .bin buffers are not supported for dropped .gltf files yet.",
    );
  });
});

describe("loadGltfModel", () => {
  test("外部binをURLから読み込める", async () => {
    const { gltf, buffer } = createTriangleGltf({ externalBufferUri: "mesh.bin" });
    const fetchedUrls = [];

    globalThis.window = { location: { href: "http://example.test/app/" } };
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchedUrls.push(url);

      if (url === "models/model.gltf") {
        return Response.json(gltf);
      }

      if (url === "http://example.test/app/models/mesh.bin") {
        return new Response(buffer);
      }

      return new Response(null, { status: 404, statusText: "Not Found" });
    };

    const model = await loadGltfModel("models/model.gltf");

    expect(fetchedUrls).toEqual([
      "models/model.gltf",
      "http://example.test/app/models/mesh.bin",
    ]);
    expect(model.triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
  });

  test("GLBをURLから読み込める", async () => {
    const glb = createTriangleGlb();

    globalThis.window = { location: { href: "http://example.test/app/" } };
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (url === "models/model.glb") {
        return new Response(glb, {
          headers: { "content-type": "application/octet-stream" },
        });
      }

      return new Response(null, { status: 404, statusText: "Not Found" });
    };

    const model = await loadGltfModel("models/model.glb");

    expect(model.triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
  });

  test("content-typeからGLBを読み込める", async () => {
    const glb = createTriangleGlb();

    globalThis.window = { location: { href: "http://example.test/app/" } };
    globalThis.fetch = async () =>
      new Response(glb, {
        headers: { "content-type": "model/gltf-binary; charset=binary" },
      });

    const model = await loadGltfModel("models/model");

    expect(model.triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
  });
});

describe("GLB validation", () => {
  test("magic headerが不正なGLBを拒否する", async () => {
    await expect(
      loadGltfModelFromFile(createGlbFile(createTriangleGlb({ magic: 0 }))),
    ).rejects.toThrow("Invalid GLB: magic header does not match.");
  });

  test("versionが不正なGLBを拒否する", async () => {
    await expect(
      loadGltfModelFromFile(createGlbFile(createTriangleGlb({ version: 1 }))),
    ).rejects.toThrow("Invalid GLB: only version 2 is supported.");
  });

  test("JSON chunk typeが不正なGLBを拒否する", async () => {
    await expect(
      loadGltfModelFromFile(createGlbFile(createTriangleGlb({ jsonChunkType: 0 }))),
    ).rejects.toThrow("Invalid GLB: first chunk must be JSON.");
  });

  test("壊れたJSON chunkを拒否する", async () => {
    await expect(
      loadGltfModelFromFile(createGlbFile(createTriangleGlb({ jsonText: "{" }))),
    ).rejects.toThrow("Invalid GLB: JSON chunk is not valid JSON.");
  });

  test("BIN chunk typeが不正なGLBを拒否する", async () => {
    await expect(
      loadGltfModelFromFile(createGlbFile(createTriangleGlb({ binChunkType: 0 }))),
    ).rejects.toThrow("Invalid GLB: second chunk must be BIN.");
  });

  test("BIN chunkがないGLBを拒否する", async () => {
    await expect(
      loadGltfModelFromFile(createGlbFile(createTriangleGlb({ includeBin: false }))),
    ).rejects.toThrow("Invalid GLB: missing BIN chunk.");
  });

  test("header lengthが不正なGLBを拒否する", async () => {
    await expect(
      loadGltfModelFromFile(createGlbFile(createTriangleGlb({ declaredLengthDelta: 4 }))),
    ).rejects.toThrow("Invalid GLB: header length does not match file length.");
  });
});

describe("fitModelToGround", () => {
  test("モデルを中心寄せして指定した高さに収める", () => {
    const model = {
      bounds: {
        min: [0, 0, 0],
        max: [2, 4, 2],
      },
      triangles: new Float32Array([
        0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1,
      ]),
      wireframe: new Float32Array([
        2, 4, 2, 0, 1, 0, 1, 1, 1, 1, 1, 1,
      ]),
    };

    const fitted = fitModelToGround(model, 2);

    expectVector(Array.from(fitted.triangles.slice(0, 3)), [-0.5, 0, -0.5]);
    expectVector(Array.from(fitted.wireframe.slice(0, 3)), [0.5, 2, 0.5]);
  });
});

function createTriangleGltf({
  colors = null,
  externalBufferUri = null,
  indices = [0, 1, 2],
  materialColor = [0.95, 0.72, 0.28],
  node = { mesh: 0 },
  normals = null,
  positionBuffer = null,
  positionByteOffset = undefined,
  positionByteStride = undefined,
  positions = [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ],
} = {}) {
  const bufferBuilder = createBufferBuilder();
  const accessors = [];

  const positionAccessor = addAccessor(
    bufferBuilder,
    accessors,
    positionBuffer ?? floatBuffer(positions),
    {
      byteOffset: positionByteOffset,
      byteStride: positionByteStride,
      componentType: GL_FLOAT,
      count: 3,
      target: ARRAY_BUFFER,
      type: "VEC3",
    },
  );

  const attributes = { POSITION: positionAccessor };

  if (normals) {
    attributes.NORMAL = addAccessor(bufferBuilder, accessors, floatBuffer(normals), {
      componentType: GL_FLOAT,
      count: 3,
      target: ARRAY_BUFFER,
      type: "VEC3",
    });
  }

  if (colors) {
    attributes.COLOR_0 = addAccessor(bufferBuilder, accessors, floatBuffer(colors), {
      componentType: GL_FLOAT,
      count: 3,
      target: ARRAY_BUFFER,
      type: "VEC4",
    });
  }

  const primitive = {
    attributes,
    material: 0,
    mode: GL_TRIANGLES,
  };

  if (indices) {
    primitive.indices = addAccessor(bufferBuilder, accessors, uint16Buffer(indices), {
      componentType: GL_UNSIGNED_SHORT,
      count: indices.length,
      target: ELEMENT_ARRAY_BUFFER,
      type: "SCALAR",
    });
  }

  const buffer = bufferBuilder.build();
  const gltf = {
    accessors,
    asset: { version: "2.0" },
    buffers: [
      {
        byteLength: buffer.byteLength,
        uri: externalBufferUri ?? dataUri(buffer),
      },
    ],
    bufferViews: bufferBuilder.bufferViews,
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [...materialColor, 1],
        },
      },
    ],
    meshes: [
      {
        primitives: [primitive],
      },
    ],
    nodes: [node],
    scene: 0,
    scenes: [{ nodes: [0] }],
  };

  return externalBufferUri ? { gltf, buffer } : gltf;
}

function addAccessor(bufferBuilder, accessors, arrayBuffer, options) {
  const bufferView = bufferBuilder.addBufferView(arrayBuffer, options);
  const accessor = accessors.length;

  accessors.push({
    bufferView,
    ...(options.byteOffset === undefined ? {} : { byteOffset: options.byteOffset }),
    componentType: options.componentType,
    count: options.count,
    type: options.type,
  });

  return accessor;
}

function createBufferBuilder() {
  const parts = [];
  const bufferViews = [];
  let byteLength = 0;

  return {
    bufferViews,
    addBufferView(arrayBuffer, { byteStride, target }) {
      const view = new Uint8Array(arrayBuffer);
      const bufferView = bufferViews.length;

      parts.push(view);
      bufferViews.push({
        buffer: 0,
        byteLength: view.byteLength,
        byteOffset: byteLength,
        target,
        ...(byteStride === undefined ? {} : { byteStride }),
      });
      byteLength += view.byteLength;

      return bufferView;
    },
    build() {
      const bytes = new Uint8Array(byteLength);
      let offset = 0;

      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }

      return bytes.buffer;
    },
  };
}

function createTriangleGlb(options = {}) {
  const { gltf, buffer } = createTriangleGltf({ externalBufferUri: "mesh.bin" });

  delete gltf.buffers[0].uri;

  return createGlb(gltf, buffer, options);
}

function createGlb(
  gltf,
  binBuffer,
  {
    binChunkType = GLB_BIN_CHUNK_TYPE,
    declaredLengthDelta = 0,
    includeBin = true,
    jsonChunkType = GLB_JSON_CHUNK_TYPE,
    jsonText = JSON.stringify(gltf),
    magic = GLB_MAGIC,
    version = GLB_VERSION,
  } = {},
) {
  const jsonChunk = padBytes(new TextEncoder().encode(jsonText), 0x20);
  const binChunk = padBytes(new Uint8Array(binBuffer), 0);
  const byteLength =
    12 + 8 + jsonChunk.byteLength + (includeBin ? 8 + binChunk.byteLength : 0);
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  view.setUint32(offset, magic, true);
  view.setUint32(offset + 4, version, true);
  view.setUint32(offset + 8, byteLength + declaredLengthDelta, true);
  offset += 12;

  view.setUint32(offset, jsonChunk.byteLength, true);
  view.setUint32(offset + 4, jsonChunkType, true);
  bytes.set(jsonChunk, offset + 8);
  offset += 8 + jsonChunk.byteLength;

  if (includeBin) {
    view.setUint32(offset, binChunk.byteLength, true);
    view.setUint32(offset + 4, binChunkType, true);
    bytes.set(binChunk, offset + 8);
  }

  return bytes.buffer;
}

function padBytes(bytes, paddingByte) {
  const paddedLength = bytes.byteLength + ((4 - (bytes.byteLength % 4)) % 4);
  const paddedBytes = new Uint8Array(paddedLength);

  paddedBytes.set(bytes);
  paddedBytes.fill(paddingByte, bytes.byteLength);

  return paddedBytes;
}

function createGltfFile(gltf, name = "model.gltf") {
  return new File([JSON.stringify(gltf)], name, { type: "model/gltf+json" });
}

function createGlbFile(arrayBuffer, name = "model.glb") {
  return new File([arrayBuffer], name, { type: "model/gltf-binary" });
}

function dataUri(arrayBuffer) {
  return `data:application/octet-stream;base64,${Buffer.from(arrayBuffer).toString("base64")}`;
}

function floatBuffer(values) {
  return new Float32Array(values).buffer;
}

function uint16Buffer(values) {
  return new Uint16Array(values).buffer;
}

function readPackedVertex(vertices, index) {
  const start = index * PACKED_VERTEX_SIZE;

  return {
    position: Array.from(vertices.slice(start, start + 3)),
    normal: Array.from(vertices.slice(start + 3, start + 6)),
    color: Array.from(vertices.slice(start + 6, start + 9)),
    materialColor: Array.from(vertices.slice(start + 9, start + 12)),
  };
}

function expectVector(received, expected) {
  expect(received).toHaveLength(expected.length);

  for (let index = 0; index < expected.length; index += 1) {
    expect(received[index]).toBeCloseTo(expected[index], 5);
  }
}
