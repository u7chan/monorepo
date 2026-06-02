# Testing Guide

## Runtime

Use `bun test` for unit tests. This project is dependency-light and uses browser-oriented JavaScript APIs that Bun can exercise without a heavier test runner.

## Test Naming

Write test case names in Japanese so failures are readable in the local workflow. Group related cases with `describe`.

## glTF Loader Tests

Prefer small synthetic glTF fixtures generated inside the test file. Do not paste large model assets or long base64 strings into tests.

Build binary buffers in JavaScript, encode them as data URIs only at runtime, and assert explicit behavior:

- packed triangle and wireframe lengths
- model bounds
- vertex position, normal, color, and material color
- sequential indices when indices are omitted
- accessor `byteOffset` and `byteStride`
- node transforms
- focused error paths

Use the large sample asset only for a separate smoke or integration test when it is necessary.

## Docker

The `Dockerfile` exposes a `test` stage. CI can run:

```bash
docker build --target test .
```
