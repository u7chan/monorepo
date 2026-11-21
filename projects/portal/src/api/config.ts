import { isMockMode } from "../services/mockData";

export function getConfig(_req: Request): Response {
  return Response.json({
    isMockMode: isMockMode(),
    host: process.env.PORTAL_HOST || "localhost",
  });
}
