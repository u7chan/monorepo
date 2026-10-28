export const staticRoutes = {
  "/favicon.ico": new Response(Bun.file(new URL("../client/assets/favicon.ico", import.meta.url)), {
    headers: {
      "Content-Type": "image/x-icon",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  }),
};
