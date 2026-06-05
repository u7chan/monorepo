import { FLOATS_PER_VERTEX } from "./vertex-layout.js";

export function createModelInfo(fileName, model) {
  const vertexCount = model.primitives.reduce(
    (sum, primitive) => sum + primitive.triangles.length / FLOATS_PER_VERTEX,
    0,
  );
  const polygonCount = vertexCount / 3;

  return {
    fileName,
    materials: model.materials ?? [],
    textures: createTextureInfo(model),
    vertexCount,
    polygonCount,
    size: [
      model.bounds.max[0] - model.bounds.min[0],
      model.bounds.max[1] - model.bounds.min[1],
      model.bounds.max[2] - model.bounds.min[2],
    ],
  };
}

function createTextureInfo(model) {
  const materials = model.materials ?? [];

  return (model.textures ?? []).map((texture, index) => ({
    imageIndex: texture.imageIndex,
    imageStatus: getImageStatus(model.images, texture.imageIndex),
    index,
    materials: materials
      .filter((material) => material.baseColorTexture?.textureIndex === index)
      .map((material) => ({
        index: material.index,
        name: material.name,
        texcoordIndex: material.baseColorTexture.texcoordIndex,
      })),
    sampler: texture.sampler ?? null,
  }));
}

function getImageStatus(images = [], imageIndex) {
  if (imageIndex === null || imageIndex === undefined) {
    return "none";
  }

  return images[imageIndex] ? "decoded" : "missing";
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
