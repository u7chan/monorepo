import { readdir } from "node:fs/promises";
import { Hono } from "hono";
import { env } from "hono/adapter";

const app = new Hono<{
  Bindings: {
    UPLOAD_DIR: string;
  };
}>();

app.get("/", async (c) => {
  const uploadDir = env(c).UPLOAD_DIR || "./tmp";
  const files = await readdir(uploadDir);
  return c.json({
    files,
  });
});

export default app;
