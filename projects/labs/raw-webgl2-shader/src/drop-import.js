export function createGltfDropImporter({ onDragChange, onDropFiles }) {
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

export function pickSingleGltfFile(files) {
  if (files.length !== 1) {
    throw new Error("Drop exactly one .gltf file.");
  }

  const gltfFiles = files.filter((file) => file.name.toLowerCase().endsWith(".gltf"));

  if (gltfFiles.length === 0) {
    throw new Error("Only .gltf files are supported.");
  }

  return gltfFiles[0];
}

function hasDraggedFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}
