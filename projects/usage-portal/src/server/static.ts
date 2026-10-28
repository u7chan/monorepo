export const staticRoutes = {
  "/favicon.ico": assetResponse("../client/assets/favicon.ico", "image/x-icon"),
  "/manifest.webmanifest": assetResponse("../client/manifest.webmanifest", "application/manifest+json", "no-cache"),
  "/icons/icon-192.png": assetResponse("../client/assets/icon-192.png", "image/png"),
  "/icons/icon-512.png": assetResponse("../client/assets/icon-512.png", "image/png"),
  "/apple-touch-icon.png": assetResponse("../client/assets/apple-touch-icon.png", "image/png"),
};

function assetResponse(path: string, contentType: string, cacheControl = "public, max-age=86400"): Response {
  return new Response(Bun.file(new URL(path, import.meta.url)), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
