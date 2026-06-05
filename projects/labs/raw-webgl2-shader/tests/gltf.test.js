import { afterEach, describe, expect, test } from "bun:test";
import {
  fitModelToGround,
  loadGltfModel,
  loadGltfModelFromFile,
  setGltfImageBitmapDecoderForTests,
} from "../src/gltf.js";

const GL_FLOAT = 5126;
const GL_LINEAR = 9729;
const GL_MIRRORED_REPEAT = 33648;
const GL_NEAREST = 9728;
const GL_REPEAT = 10497;
const GL_UNSIGNED_SHORT = 5123;
const GL_TRIANGLES = 4;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const PACKED_VERTEX_SIZE = 12;
const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a;
const GLB_BIN_CHUNK_TYPE = 0x004e4942;
const GLB_HEADER_SIZE = 12;

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setGltfImageBitmapDecoderForTests(null);

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

    expect(model).not.toHaveProperty("triangles");
    expect(model).not.toHaveProperty("wireframe");
    expect(model.primitives).toHaveLength(1);
    expect(model.primitives[0].materialIndex).toBe(0);
    expect(model.primitives[0].texcoords).toBe(null);
    expect(model.primitives[0].triangles).toBeInstanceOf(Float32Array);
    expect(model.primitives[0].wireframe).toBeInstanceOf(Float32Array);
    expect(model.primitives[0].triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
    expect(model.primitives[0].wireframe.length).toBe(6 * PACKED_VERTEX_SIZE);
    expectVector(model.bounds.min, [0, 0, 0]);
    expectVector(model.bounds.max, [1, 1, 0]);
    expectVector(readPackedVertex(model.primitives[0].triangles, 0).position, [0, 0, 0]);
    expectVector(readPackedVertex(model.primitives[0].triangles, 0).normal, [0, 0, 1]);
    expectVector(readPackedVertex(model.primitives[0].triangles, 0).color, [1, 0, 0]);
    expectVector(readPackedVertex(model.primitives[0].triangles, 0).materialColor, [0.25, 0.5, 0.75]);
    expect(model.materials).toEqual([
      {
        baseColorFactor: [0.25, 0.5, 0.75, 1],
        baseColor: [0.25, 0.5, 0.75],
        baseColorTexture: null,
        index: 0,
        name: "",
      },
    ]);
  });

  test("indicesがない場合は頂点順で三角形を作る", async () => {
    const gltf = createTriangleGltf({ indices: null });

    const model = await loadGltfModelFromFile(createGltfFile(gltf));

    expect(model.primitives[0].triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
    expectVector(readPackedVertex(model.primitives[0].triangles, 0).position, [0, 0, 0]);
    expectVector(readPackedVertex(model.primitives[0].triangles, 1).position, [1, 0, 0]);
    expectVector(readPackedVertex(model.primitives[0].triangles, 2).position, [0, 1, 0]);
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

    expectVector(readPackedVertex(model.primitives[0].triangles, 2).position, [0, 1, 0]);
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

    expectVector(readPackedVertex(model.primitives[0].triangles, 0).position, [0, 0, 0]);
    expectVector(readPackedVertex(model.primitives[0].triangles, 2).position, [0, 1, 0]);
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
    expectVector(readPackedVertex(model.primitives[0].triangles, 1).position, [12, 20, 30]);
  });

  test("NORMALとCOLOR_0がない場合はデフォルト値とmaterial色を使う", async () => {
    const gltf = createTriangleGltf({
      materialColor: [0.1, 0.2, 0.3],
    });

    const model = await loadGltfModelFromFile(createGltfFile(gltf));
    const vertex = readPackedVertex(model.primitives[0].triangles, 0);

    expectVector(vertex.normal, [0, 1, 0]);
    expectVector(vertex.color, [0.1, 0.2, 0.3]);
    expectVector(vertex.materialColor, [0.1, 0.2, 0.3]);
  });

  test("複数primitiveを分けて読み込む", async () => {
    const gltf = createTriangleGltf({
      primitiveOverrides: [
        { material: 0 },
        {
          indices: [2, 1, 0],
          material: 1,
        },
      ],
      materials: [
        { pbrMetallicRoughness: { baseColorFactor: [0.1, 0.2, 0.3, 0.4] } },
        { name: "Default factor material" },
      ],
    });

    const model = await loadGltfModelFromFile(createGltfFile(gltf));

    expect(model.primitives).toHaveLength(2);
    expect(model.primitives[0].materialIndex).toBe(0);
    expect(model.primitives[1].materialIndex).toBe(1);
    expect(model.primitives[0].triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
    expect(model.primitives[1].triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
    expectVector(
      readPackedVertex(model.primitives[1].triangles, 0).materialColor,
      [0.95, 0.72, 0.28],
    );
    expect(model.materials).toEqual([
      {
        baseColor: [0.1, 0.2, 0.3],
        baseColorFactor: [0.1, 0.2, 0.3, 0.4],
        baseColorTexture: null,
        index: 0,
        name: "",
      },
      {
        baseColor: [0.95, 0.72, 0.28],
        baseColorFactor: [0.95, 0.72, 0.28, 1],
        baseColorTexture: null,
        index: 1,
        name: "Default factor material",
      },
    ]);
  });

  test("material未指定primitiveはdefault色を焼き込みmaterialsには追加しない", async () => {
    const gltf = createTriangleGltf({
      primitiveOverrides: [{ material: undefined }],
    });

    const model = await loadGltfModelFromFile(createGltfFile(gltf));

    expect(model.primitives[0].materialIndex).toBe(null);
    expectVector(
      readPackedVertex(model.primitives[0].triangles, 0).color,
      [0.95, 0.72, 0.28],
    );
    expectVector(
      readPackedVertex(model.primitives[0].triangles, 0).materialColor,
      [0.95, 0.72, 0.28],
    );
    expect(model.materials).toHaveLength(1);
  });

  test("TEXCOORD_0をtriangle頂点順のprimitive texcoordsに展開する", async () => {
    const gltf = createTriangleGltf({
      indices: [2, 0, 1],
      texcoords: [
        0, 0,
        1, 0,
        0.5, 1,
      ],
    });

    const model = await loadGltfModelFromFile(createGltfFile(gltf));

    expect(model.primitives[0].texcoords).toBeInstanceOf(Float32Array);
    expectVector(Array.from(model.primitives[0].texcoords), [
      0.5, 1,
      0, 0,
      1, 0,
    ]);
  });

  test("GLBのbufferView画像をbaseColorTextureとしてdecodeする", async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71]);
    const decoded = [];
    const { gltf, buffer } = createTriangleGltf({
      externalBufferUri: "mesh.bin",
      imageBuffer: imageBytes.buffer,
      imageMimeType: "image/png",
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorFactor: [0.25, 0.5, 0.75, 0.6],
            baseColorTexture: { index: 0 },
          },
        },
      ],
      texcoords: [
        0, 0,
        1, 0,
        0.5, 1,
      ],
    });

    delete gltf.buffers[0].uri;
    setGltfImageBitmapDecoderForTests(async (blob) => {
      decoded.push({
        bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
        type: blob.type,
      });

      return { close() {} };
    });

    const model = await loadGltfModelFromFile(createGlbFile(createGlb(gltf, buffer)));

    expect(decoded).toEqual([{ bytes: [137, 80, 78, 71], type: "image/png" }]);
    expect(model.images).toHaveLength(1);
    expect(model.images[0]).not.toBe(null);
    expect(model.materials[0].baseColorTexture).toEqual({
      imageIndex: 0,
      texcoordIndex: 0,
      textureIndex: 0,
    });
    expect(model.textures).toEqual([
      {
        imageIndex: 0,
        sampler: {
          magFilter: GL_LINEAR,
          minFilter: GL_LINEAR,
          wrapS: GL_REPEAT,
          wrapT: GL_REPEAT,
        },
      },
    ]);
  });

  test("samplerはtexture単位で保持し未指定wrapはREPEATにする", async () => {
    const gltf = createTriangleGltf({
      imageUri: dataUri(new Uint8Array([1, 2, 3]).buffer, "image/png"),
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorTexture: { index: 0 },
          },
        },
        {
          pbrMetallicRoughness: {
            baseColorTexture: { index: 1 },
          },
        },
      ],
    });

    gltf.samplers = [
      {
        magFilter: GL_NEAREST,
        minFilter: GL_NEAREST,
        wrapS: GL_MIRRORED_REPEAT,
        wrapT: GL_REPEAT,
      },
    ];
    gltf.textures = [
      { sampler: 0, source: 0 },
      { source: 0 },
    ];
    setGltfImageBitmapDecoderForTests(async () => ({ close() {} }));

    const model = await loadGltfModelFromFile(createGltfFile(gltf));

    expect(model.materials[0].baseColorTexture).toEqual({
      imageIndex: 0,
      texcoordIndex: 0,
      textureIndex: 0,
    });
    expect(model.materials[1].baseColorTexture).toEqual({
      imageIndex: 0,
      texcoordIndex: 0,
      textureIndex: 1,
    });
    expect(model.textures).toEqual([
      {
        imageIndex: 0,
        sampler: {
          magFilter: GL_NEAREST,
          minFilter: GL_NEAREST,
          wrapS: GL_MIRRORED_REPEAT,
          wrapT: GL_REPEAT,
        },
      },
      {
        imageIndex: 0,
        sampler: {
          magFilter: GL_LINEAR,
          minFilter: GL_LINEAR,
          wrapS: GL_REPEAT,
          wrapT: GL_REPEAT,
        },
      },
    ]);
  });

  test("data URI画像をbaseColorTextureとしてdecodeする", async () => {
    const imageBytes = new Uint8Array([1, 2, 3]);
    const decoded = [];
    const gltf = createTriangleGltf({
      imageUri: dataUri(imageBytes.buffer, "image/jpeg"),
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorFactor: [1, 1, 1, 1],
            baseColorTexture: { index: 0, texCoord: 0 },
          },
        },
      ],
      texcoords: [
        0, 0,
        1, 0,
        0.5, 1,
      ],
    });

    setGltfImageBitmapDecoderForTests(async (blob) => {
      decoded.push({
        bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
        type: blob.type,
      });

      return { close() {} };
    });

    const model = await loadGltfModelFromFile(createGltfFile(gltf));

    expect(decoded).toEqual([{ bytes: [1, 2, 3], type: "image/jpeg" }]);
    expect(model.images[0]).not.toBe(null);
    expect(model.materials[0].baseColorTexture).toEqual({
      imageIndex: 0,
      texcoordIndex: 0,
      textureIndex: 0,
    });
  });

  test("mimeType未指定のbufferView画像はtypeなしBlobでdecodeを試す", async () => {
    const decodedTypes = [];
    const { gltf, buffer } = createTriangleGltf({
      externalBufferUri: "mesh.bin",
      imageBuffer: new Uint8Array([9, 8, 7]).buffer,
      imageMimeType: null,
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorFactor: [1, 1, 1, 1],
            baseColorTexture: { index: 0 },
          },
        },
      ],
    });

    delete gltf.buffers[0].uri;
    setGltfImageBitmapDecoderForTests(async (blob) => {
      decodedTypes.push(blob.type);

      return { close() {} };
    });

    await loadGltfModelFromFile(createGlbFile(createGlb(gltf, buffer)));

    expect(decodedTypes).toEqual([""]);
  });

  test("画像decode失敗時もmodel読み込みを継続しtextureだけ無効化する", async () => {
    const gltf = createTriangleGltf({
      imageUri: dataUri(new Uint8Array([1]).buffer, "image/png"),
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorFactor: [0.1, 0.2, 0.3, 1],
            baseColorTexture: { index: 0 },
          },
        },
      ],
    });

    setGltfImageBitmapDecoderForTests(async () => {
      throw new Error("decode failed");
    });

    const model = await loadGltfModelFromFile(createGltfFile(gltf));

    expect(model.primitives[0].triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
    expect(model.images).toEqual([null]);
    expect(model.materials[0].baseColorTexture).toEqual({
      imageIndex: 0,
      texcoordIndex: 0,
      textureIndex: 0,
    });
  });

  test("GLBの三角形を読み込める", async () => {
    const model = await loadGltfModelFromFile(createGlbFile(createTriangleGlb()));

    expect(model.primitives[0].triangles).toBeInstanceOf(Float32Array);
    expect(model.primitives[0].triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
    expect(model.primitives[0].wireframe.length).toBe(6 * PACKED_VERTEX_SIZE);
    expectVector(model.bounds.min, [0, 0, 0]);
    expectVector(model.bounds.max, [1, 1, 0]);
    expectVector(readPackedVertex(model.primitives[0].triangles, 2).position, [0, 1, 0]);
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
    expect(model.primitives[0].triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
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

    expect(model.primitives[0].triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
  });

  test("content-typeからGLBを読み込める", async () => {
    const glb = createTriangleGlb();

    globalThis.window = { location: { href: "http://example.test/app/" } };
    globalThis.fetch = async () =>
      new Response(glb, {
        headers: { "content-type": "model/gltf-binary; charset=binary" },
      });

    const model = await loadGltfModel("models/model");

    expect(model.primitives[0].triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
  });
});

describe("GLB validation", () => {
  test("BIN chunk後の未知chunkを無視する", async () => {
    const model = await loadGltfModelFromFile(
      createGlbFile(
        createTriangleGlb({
          chunksAfterBin: [{ type: 0x12345678, data: [1, 2, 3] }],
        }),
      ),
    );

    expect(model.primitives[0].triangles.length).toBe(3 * PACKED_VERTEX_SIZE);
  });

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
    ).rejects.toThrow("Invalid GLB: missing BIN chunk.");
  });

  test("BIN chunkがないGLBを拒否する", async () => {
    await expect(
      loadGltfModelFromFile(createGlbFile(createTriangleGlb({ includeBin: false }))),
    ).rejects.toThrow("Invalid GLB: missing BIN chunk.");
  });

  test("複数のBIN chunkを拒否する", async () => {
    await expect(
      loadGltfModelFromFile(
        createGlbFile(
          createTriangleGlb({
            chunksAfterBin: [{ type: GLB_BIN_CHUNK_TYPE, data: [0] }],
          }),
        ),
      ),
    ).rejects.toThrow("Invalid GLB: multiple BIN chunks are not supported.");
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
      materials: [],
      primitives: [
        {
          materialIndex: null,
          texcoords: new Float32Array([0, 0]),
          triangles: new Float32Array([
            0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1,
          ]),
          wireframe: new Float32Array([
            2, 4, 2, 0, 1, 0, 1, 1, 1, 1, 1, 1,
          ]),
        },
      ],
    };

    const fitted = fitModelToGround(model, 2);

    expectVector(Array.from(fitted.primitives[0].triangles.slice(0, 3)), [-0.5, 0, -0.5]);
    expectVector(Array.from(fitted.primitives[0].wireframe.slice(0, 3)), [0.5, 2, 0.5]);
    expect(fitted.primitives[0].texcoords).toBe(model.primitives[0].texcoords);
  });
});

function createTriangleGltf({
  colors = null,
  externalBufferUri = null,
  indices = [0, 1, 2],
  materialColor = [0.95, 0.72, 0.28],
  materials = [
    {
      pbrMetallicRoughness: {
        baseColorFactor: [...materialColor, 1],
      },
    },
  ],
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
  primitiveOverrides = null,
  texcoords = null,
  imageBuffer = null,
  imageMimeType = "image/png",
  imageUri = null,
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

  if (texcoords) {
    attributes.TEXCOORD_0 = addAccessor(bufferBuilder, accessors, floatBuffer(texcoords), {
      componentType: GL_FLOAT,
      count: 3,
      target: ARRAY_BUFFER,
      type: "VEC2",
    });
  }

  const createPrimitive = (override = {}) => {
    const { indices: overrideIndices, ...primitiveOptions } = override;
    const primitive = {
      attributes,
      mode: GL_TRIANGLES,
      ...("material" in override ? {} : { material: 0 }),
      ...primitiveOptions,
    };
    const primitiveIndices = "indices" in override ? overrideIndices : indices;

    if (primitiveIndices) {
      primitive.indices = addAccessor(bufferBuilder, accessors, uint16Buffer(primitiveIndices), {
        componentType: GL_UNSIGNED_SHORT,
        count: primitiveIndices.length,
        target: ELEMENT_ARRAY_BUFFER,
        type: "SCALAR",
      });
    }

    return primitive;
  };

  const primitives = (primitiveOverrides ?? [{}]).map(createPrimitive);
  const images = [];
  const textures = [];

  if (imageBuffer) {
    const image = {
      bufferView: bufferBuilder.addBufferView(imageBuffer, {}),
    };

    if (imageMimeType !== null) {
      image.mimeType = imageMimeType;
    }

    images.push(image);
    textures.push({ source: 0 });
  } else if (imageUri) {
    images.push({ uri: imageUri });
    textures.push({ source: 0 });
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
    materials,
    meshes: [
      {
        primitives,
      },
    ],
    nodes: [node],
    scene: 0,
    scenes: [{ nodes: [0] }],
    ...(images.length === 0 ? {} : { images, textures }),
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
    chunksAfterBin = [],
    declaredLengthDelta = 0,
    includeBin = true,
    jsonChunkType = GLB_JSON_CHUNK_TYPE,
    jsonText = JSON.stringify(gltf),
    magic = GLB_MAGIC,
    version = GLB_VERSION,
  } = {},
) {
  const chunks = [
    {
      data: padBytes(new TextEncoder().encode(jsonText), 0x20),
      type: jsonChunkType,
    },
  ];

  if (includeBin) {
    chunks.push({
      data: padBytes(new Uint8Array(binBuffer), 0),
      type: binChunkType,
    });
  }

  for (const chunk of chunksAfterBin) {
    chunks.push({
      data: padBytes(new Uint8Array(chunk.data), 0),
      type: chunk.type,
    });
  }

  const byteLength =
    GLB_HEADER_SIZE +
    chunks.reduce((sum, chunk) => sum + 8 + chunk.data.byteLength, 0);
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  view.setUint32(offset, magic, true);
  view.setUint32(offset + 4, version, true);
  view.setUint32(offset + 8, byteLength + declaredLengthDelta, true);
  offset += GLB_HEADER_SIZE;

  for (const chunk of chunks) {
    view.setUint32(offset, chunk.data.byteLength, true);
    view.setUint32(offset + 4, chunk.type, true);
    bytes.set(chunk.data, offset + 8);
    offset += 8 + chunk.data.byteLength;
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

function dataUri(arrayBuffer, mimeType = "application/octet-stream") {
  return `data:${mimeType};base64,${Buffer.from(arrayBuffer).toString("base64")}`;
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
