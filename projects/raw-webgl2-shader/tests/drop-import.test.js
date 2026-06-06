import { describe, expect, test } from "bun:test";
import { pickSingleModelFile } from "../src/drop-import.js";

describe("pickSingleModelFile", () => {
  test(".gltfファイルを受け付ける", () => {
    const file = new File(["{}"], "model.gltf");

    expect(pickSingleModelFile([file])).toBe(file);
  });

  test(".glbファイルを受け付ける", () => {
    const file = new File([new ArrayBuffer(0)], "model.glb");

    expect(pickSingleModelFile([file])).toBe(file);
  });

  test("複数ファイルを拒否する", () => {
    expect(() =>
      pickSingleModelFile([
        new File(["{}"], "a.gltf"),
        new File([new ArrayBuffer(0)], "b.glb"),
      ]),
    ).toThrow("Drop exactly one .gltf or .glb file.");
  });

  test("未対応拡張子を拒否する", () => {
    expect(() => pickSingleModelFile([new File([""], "model.obj")])).toThrow(
      "Only .gltf and .glb files are supported.",
    );
  });
});
