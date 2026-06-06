export function createModelDropImporter({ onDragChange, onDropFiles }) {
  let dragDepth = 0;

  window.addEventListener("dragenter", (event) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    dragDepth += 1;
    onDragChange(true);
  });

  window.addEventListener("dragover", (event) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });

  window.addEventListener("dragleave", (event) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    dragDepth = Math.max(dragDepth - 1, 0);
    if (dragDepth === 0) {
      onDragChange(false);
    }
  });

  window.addEventListener("drop", (event) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    dragDepth = 0;
    onDragChange(false);
    onDropFiles(Array.from(event.dataTransfer.files ?? []));
  });
}

export const createGltfDropImporter = createModelDropImporter;

export function pickSingleModelFile(files) {
  if (files.length !== 1) {
    throw new Error("Drop exactly one .gltf or .glb file.");
  }

  const modelFiles = files.filter(isSupportedModelFile);

  if (modelFiles.length === 0) {
    throw new Error("Only .gltf and .glb files are supported.");
  }

  return modelFiles[0];
}

export const pickSingleGltfFile = pickSingleModelFile;

function hasDraggedFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function isSupportedModelFile(file) {
  const fileName = file.name.toLowerCase();

  return fileName.endsWith(".gltf") || fileName.endsWith(".glb");
}
