export function makeOrthographicMatrix(left, right, bottom, top, near, far) {
  return new Float32Array([
    2 / (right - left),
    0,
    0,
    0,
    0,
    2 / (top - bottom),
    0,
    0,
    0,
    0,
    2 / (near - far),
    0,
    (left + right) / (left - right),
    (bottom + top) / (bottom - top),
    (near + far) / (near - far),
    1,
  ]);
}

export function makeLookAtMatrix(eye, target, up) {
  const zAxis = normalize(subtractVectors(eye, target));
  const xAxis = normalize(cross(up, zAxis));
  const yAxis = cross(zAxis, xAxis);

  return new Float32Array([
    xAxis[0],
    yAxis[0],
    zAxis[0],
    0,
    xAxis[1],
    yAxis[1],
    zAxis[1],
    0,
    xAxis[2],
    yAxis[2],
    zAxis[2],
    0,
    -dot(xAxis, eye),
    -dot(yAxis, eye),
    -dot(zAxis, eye),
    1,
  ]);
}

export function multiplyMatrices(a, b) {
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

function subtractVectors(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);

  if (length === 0) {
    return [0, 0, 0];
  }

  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
