import { describe, expect, test } from "bun:test";
import { createModelInfo, formatModelSize } from "../src/model-info.js";

describe("createModelInfo", () => {
  test("描画頂点数、三角形ポリゴン数、モデルサイズを算出する", () => {
    const model = {
      bounds: {
        min: [-1, 2, 0.25],
        max: [3, 5.5, 1],
      },
      materials: [
        {
          baseColorFactor: [0.95, 0.72, 0.28, 1],
          baseColor: [0.95, 0.72, 0.28],
          baseColorTexture: null,
          index: 0,
          name: "Body",
        },
      ],
      primitives: [
        {
          triangles: new Float32Array(3 * 12),
        },
        {
          triangles: new Float32Array(3 * 12),
        },
      ],
    };

    expect(createModelInfo("sample.glb", model)).toEqual({
      fileName: "sample.glb",
      materials: [
        {
          baseColorFactor: [0.95, 0.72, 0.28, 1],
          baseColor: [0.95, 0.72, 0.28],
          baseColorTexture: null,
          index: 0,
          name: "Body",
        },
      ],
      textures: [],
      vertexCount: 6,
      polygonCount: 2,
      size: [4, 3.5, 0.75],
    });
  });

  test("texture情報と参照materialを算出する", () => {
    const bitmap = {};
    const model = {
      bounds: {
        min: [0, 0, 0],
        max: [1, 1, 1],
      },
      images: [bitmap, null],
      materials: [
        {
          baseColorTexture: {
            texcoordIndex: 0,
            textureIndex: 0,
          },
          index: 0,
          name: "Body",
        },
        {
          baseColorTexture: {
            texcoordIndex: 1,
            textureIndex: 1,
          },
          index: 1,
          name: "",
        },
      ],
      primitives: [{ triangles: new Float32Array(3 * 12) }],
      textures: [
        {
          imageIndex: 0,
          sampler: {
            magFilter: 9729,
            minFilter: 9729,
            wrapS: 10497,
            wrapT: 10497,
          },
        },
        {
          imageIndex: 1,
          sampler: null,
        },
      ],
    };

    expect(createModelInfo("sample.glb", model).textures).toEqual([
      {
        imageIndex: 0,
        imageStatus: "decoded",
        index: 0,
        materials: [{ index: 0, name: "Body", texcoordIndex: 0 }],
        sampler: {
          magFilter: 9729,
          minFilter: 9729,
          wrapS: 10497,
          wrapT: 10497,
        },
      },
      {
        imageIndex: 1,
        imageStatus: "missing",
        index: 1,
        materials: [{ index: 1, name: "", texcoordIndex: 1 }],
        sampler: null,
      },
    ]);
  });
});

describe("formatModelSize", () => {
  test("小数を3桁までに丸めてXYZを表示する", () => {
    expect(formatModelSize([1, 2.34567, 0.5])).toBe("1 x 2.346 x 0.5");
  });
});
