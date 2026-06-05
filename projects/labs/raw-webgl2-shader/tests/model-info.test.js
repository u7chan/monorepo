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
      vertexCount: 6,
      polygonCount: 2,
      size: [4, 3.5, 0.75],
    });
  });
});

describe("formatModelSize", () => {
  test("小数を3桁までに丸めてXYZを表示する", () => {
    expect(formatModelSize([1, 2.34567, 0.5])).toBe("1 x 2.346 x 0.5");
  });
});
