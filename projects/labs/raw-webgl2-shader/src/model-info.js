import { FLOATS_PER_VERTEX } from "./vertex-layout.js";

export function createModelInfo(fileName, model) {
  const vertexCount = model.triangles.length / FLOATS_PER_VERTEX;
  const polygonCount = vertexCount / 3;

  return {
    fileName,
    materials: model.materials ?? [],
    vertexCount,
    polygonCount,
    size: [
      model.bounds.max[0] - model.bounds.min[0],
      model.bounds.max[1] - model.bounds.min[1],
      model.bounds.max[2] - model.bounds.min[2],
    ],
  };
}

export function formatModelSize(size) {
  return size.map(formatLength).join(" x ");
}

function formatLength(value) {
  const rounded = Math.round(value * 1000) / 1000;

  if (Number.isInteger(rounded)) {
    return String(rounded);
  }

  return rounded.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
