export const DEFAULT_BACKGROUND_COLOR = "#0f1214";
export const DEFAULT_WIREFRAME_COLOR = "#000000";

// Keep this aligned with the canonical value shape emitted by input[type="color"].
const HEX_COLOR_PATTERN = /^#[\da-f]{6}$/i;

export function normalizeHexColor(value, fallback) {
  if (typeof value === "string" && HEX_COLOR_PATTERN.test(value)) {
    return value.toLowerCase();
  }

  return fallback;
}

export function hexColorToRgb(value) {
  const color = normalizeHexColor(value, "#000000");

  return [
    Number.parseInt(color.slice(1, 3), 16) / 255,
    Number.parseInt(color.slice(3, 5), 16) / 255,
    Number.parseInt(color.slice(5, 7), 16) / 255,
  ];
}
