const COMPONENT_READERS = {
  5120: { byteSize: 1, read: (view, offset) => view.getInt8(offset) },
  5121: { byteSize: 1, read: (view, offset) => view.getUint8(offset) },
  5122: {
    byteSize: 2,
    read: (view, offset) => view.getInt16(offset, true),
  },
  5123: {
    byteSize: 2,
    read: (view, offset) => view.getUint16(offset, true),
  },
  5125: {
    byteSize: 4,
    read: (view, offset) => view.getUint32(offset, true),
  },
  5126: {
    byteSize: 4,
    read: (view, offset) => view.getFloat32(offset, true),
  },
};

const TYPE_COMPONENT_COUNTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
};

const GL_TRIANGLES = 4;
const DEFAULT_COLOR = [0.95, 0.72, 0.28];
const DEFAULT_NORMAL = [0, 1, 0];
const IDENTITY_MATRIX = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

export async function loadGltfModel(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to load glTF: ${response.status} ${response.statusText}`);
  }

  const gltf = await response.json();
  const baseUrl = new URL(url, window.location.href);
  const buffers = await loadBuffers(gltf, baseUrl);
  const model = {
    bounds: createEmptyBounds(),
    triangles: [],
    wireframe: [],
  };

  for (const sceneIndex of getSceneNodeIndices(gltf)) {
    appendNode(model, gltf, buffers, sceneIndex, IDENTITY_MATRIX);
  }

  return {
    bounds: model.bounds,
    triangles: new Float32Array(model.triangles),
    wireframe: new Float32Array(model.wireframe),
  };
}

export function fitModelToGround(model, targetHeight = 1.45) {
  const { bounds } = model;

  if (!Number.isFinite(bounds.min[0]) || bounds.max[1] === bounds.min[1]) {
    return model;
  }

  const scale = targetHeight / (bounds.max[1] - bounds.min[1]);
  const centerX = (bounds.min[0] + bounds.max[0]) * 0.5;
  const centerZ = (bounds.min[2] + bounds.max[2]) * 0.5;

  return {
    bounds: model.bounds,
    triangles: fitVertices(model.triangles, centerX, bounds.min[1], centerZ, scale),
    wireframe: fitVertices(model.wireframe, centerX, bounds.min[1], centerZ, scale),
  };
}

async function loadBuffers(gltf, baseUrl) {
  return Promise.all(
    (gltf.buffers ?? []).map(async (buffer) => {
      if (!buffer.uri) {
        throw new Error("Binary .glb buffers are not supported yet.");
      }

      if (buffer.uri.startsWith("data:")) {
        return decodeDataUri(buffer.uri);
      }

      const response = await fetch(new URL(buffer.uri, baseUrl));

      if (!response.ok) {
        throw new Error(
          `Failed to load glTF buffer: ${response.status} ${response.statusText}`,
        );
      }

      return response.arrayBuffer();
    }),
  );
}

function getSceneNodeIndices(gltf) {
  const scene = gltf.scenes?.[gltf.scene ?? 0];

  return scene?.nodes ?? gltf.nodes?.map((_, index) => index) ?? [];
}

function appendNode(model, gltf, buffers, nodeIndex, parentMatrix) {
  const node = gltf.nodes?.[nodeIndex];

  if (!node) {
    return;
  }

  const worldMatrix = multiplyMatrices(parentMatrix, getNodeMatrix(node));

  if (node.mesh !== undefined) {
    appendMesh(model, gltf, buffers, node.mesh, worldMatrix);
  }

  for (const childIndex of node.children ?? []) {
    appendNode(model, gltf, buffers, childIndex, worldMatrix);
  }
}

function appendMesh(model, gltf, buffers, meshIndex, matrix) {
  const mesh = gltf.meshes?.[meshIndex];

  if (!mesh) {
    return;
  }

  for (const primitive of mesh.primitives ?? []) {
    if (primitive.mode !== undefined && primitive.mode !== GL_TRIANGLES) {
      continue;
    }

    appendPrimitive(model, gltf, buffers, primitive, matrix);
  }
}

function appendPrimitive(model, gltf, buffers, primitive, matrix) {
  const positionAccessorIndex = primitive.attributes?.POSITION;

  if (positionAccessorIndex === undefined) {
    return;
  }

  const positions = readAccessor(gltf, buffers, positionAccessorIndex);
  const normals =
    primitive.attributes.NORMAL === undefined
      ? null
      : readAccessor(gltf, buffers, primitive.attributes.NORMAL);
  const colors =
    primitive.attributes.COLOR_0 === undefined
      ? null
      : readAccessor(gltf, buffers, primitive.attributes.COLOR_0);
  const indices =
    primitive.indices === undefined
      ? createSequentialIndices(positions.count)
      : readAccessor(gltf, buffers, primitive.indices);
  const materialColor = getMaterialColor(gltf, primitive.material);

  for (let index = 0; index < indices.count; index += 3) {
    const a = indices.get(index);
    const b = indices.get(index + 1);
    const c = indices.get(index + 2);
    const triangle = [
      createVertex(positions, normals, colors, materialColor, matrix, a),
      createVertex(positions, normals, colors, materialColor, matrix, b),
      createVertex(positions, normals, colors, materialColor, matrix, c),
    ];

    pushPackedVertex(model.triangles, model.bounds, triangle[0]);
    pushPackedVertex(model.triangles, model.bounds, triangle[1]);
    pushPackedVertex(model.triangles, model.bounds, triangle[2]);

    pushPackedVertex(model.wireframe, model.bounds, triangle[0]);
    pushPackedVertex(model.wireframe, model.bounds, triangle[1]);
    pushPackedVertex(model.wireframe, model.bounds, triangle[1]);
    pushPackedVertex(model.wireframe, model.bounds, triangle[2]);
    pushPackedVertex(model.wireframe, model.bounds, triangle[2]);
    pushPackedVertex(model.wireframe, model.bounds, triangle[0]);
  }
}

function createVertex(positions, normals, colors, materialColor, matrix, vertexIndex) {
  const position = transformPoint(matrix, positions.get(vertexIndex));
  const normal = normalize(transformDirection(matrix, normals?.get(vertexIndex) ?? DEFAULT_NORMAL));
  const color = colors?.get(vertexIndex) ?? materialColor;

  return {
    color: [color[0], color[1], color[2]],
    materialColor,
    normal,
    position,
  };
}

function pushPackedVertex(vertices, bounds, vertex) {
  expandBounds(bounds, vertex.position);
  vertices.push(
    vertex.position[0],
    vertex.position[1],
    vertex.position[2],
    vertex.normal[0],
    vertex.normal[1],
    vertex.normal[2],
    vertex.color[0],
    vertex.color[1],
    vertex.color[2],
    vertex.materialColor[0],
    vertex.materialColor[1],
    vertex.materialColor[2],
  );
}

function getMaterialColor(gltf, materialIndex) {
  const factor =
    gltf.materials?.[materialIndex]?.pbrMetallicRoughness?.baseColorFactor ??
    DEFAULT_COLOR;

  return [factor[0], factor[1], factor[2]];
}

function fitVertices(vertices, centerX, minY, centerZ, scale) {
  const fitted = new Float32Array(vertices);

  for (let index = 0; index < fitted.length; index += 12) {
    fitted[index] = (fitted[index] - centerX) * scale;
    fitted[index + 1] = (fitted[index + 1] - minY) * scale;
    fitted[index + 2] = (fitted[index + 2] - centerZ) * scale;
  }

  return fitted;
}

function readAccessor(gltf, buffers, accessorIndex) {
  const accessor = gltf.accessors?.[accessorIndex];

  if (!accessor) {
    throw new Error(`glTF accessor ${accessorIndex} was not found.`);
  }

  const componentCount = TYPE_COMPONENT_COUNTS[accessor.type];
  const reader = COMPONENT_READERS[accessor.componentType];

  if (!componentCount || !reader) {
    throw new Error(`Unsupported glTF accessor format: ${accessor.type}`);
  }

  const bufferView = gltf.bufferViews?.[accessor.bufferView];

  if (!bufferView) {
    throw new Error(`glTF bufferView ${accessor.bufferView} was not found.`);
  }

  const dataView = new DataView(buffers[bufferView.buffer]);
  const bufferOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const packedByteStride = componentCount * reader.byteSize;
  const byteStride = bufferView.byteStride ?? packedByteStride;

  return {
    count: accessor.count,
    get(index) {
      const itemOffset = bufferOffset + index * byteStride;
      const values = [];

      for (let component = 0; component < componentCount; component += 1) {
        const componentOffset = itemOffset + component * reader.byteSize;

        values.push(reader.read(dataView, componentOffset));
      }

      return values;
    },
  };
}

function createSequentialIndices(count) {
  return {
    count,
    get(index) {
      return index;
    },
  };
}

function decodeDataUri(uri) {
  const commaIndex = uri.indexOf(",");

  if (commaIndex === -1) {
    throw new Error("Invalid glTF data URI.");
  }

  const metadata = uri.slice(0, commaIndex);
  const data = uri.slice(commaIndex + 1);

  if (!metadata.endsWith(";base64")) {
    throw new Error("Only base64 glTF data URIs are supported.");
  }

  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function getNodeMatrix(node) {
  if (node.matrix) {
    return new Float32Array(node.matrix);
  }

  const translation = node.translation ?? [0, 0, 0];
  const rotation = node.rotation ?? [0, 0, 0, 1];
  const scale = node.scale ?? [1, 1, 1];

  return composeMatrix(translation, rotation, scale);
}

function composeMatrix(translation, rotation, scale) {
  const [x, y, z, w] = rotation;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  return new Float32Array([
    (1 - (yy + zz)) * scale[0],
    (xy + wz) * scale[0],
    (xz - wy) * scale[0],
    0,
    (xy - wz) * scale[1],
    (1 - (xx + zz)) * scale[1],
    (yz + wx) * scale[1],
    0,
    (xz + wy) * scale[2],
    (yz - wx) * scale[2],
    (1 - (xx + yy)) * scale[2],
    0,
    translation[0],
    translation[1],
    translation[2],
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

function transformPoint(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}

function transformDirection(matrix, direction) {
  return [
    matrix[0] * direction[0] + matrix[4] * direction[1] + matrix[8] * direction[2],
    matrix[1] * direction[0] + matrix[5] * direction[1] + matrix[9] * direction[2],
    matrix[2] * direction[0] + matrix[6] * direction[1] + matrix[10] * direction[2],
  ];
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);

  if (length === 0) {
    return [0, 1, 0];
  }

  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function createEmptyBounds() {
  return {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  };
}

function expandBounds(bounds, position) {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], position[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], position[axis]);
  }
}
