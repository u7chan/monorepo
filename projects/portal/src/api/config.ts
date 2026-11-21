export function getConfig(_req: Request): Response {
  return Response.json({
    isMockMode: process.env.USE_MOCK_DATA === "true",
    host: process.env.PORTAL_HOST || "localhost",
  });
}
