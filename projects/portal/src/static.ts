export const staticRoutes = {
  "/manifest.webmanifest": assetResponse(
    "./manifest.webmanifest",
    "application/manifest+json",
    "no-cache",
  ),
  "/icons/icon-192.png": assetResponse("./assets/icon-192.png", "image/png"),
  "/icons/icon-512.png": assetResponse("./assets/icon-512.png", "image/png"),
  "/apple-touch-icon.png": assetResponse("./assets/apple-touch-icon.png", "image/png"),
};

function assetResponse(
  path: string,
  contentType: string,
  cacheControl = "public, max-age=86400",
): Response {
  return new Response(Bun.file(new URL(path, import.meta.url)), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
