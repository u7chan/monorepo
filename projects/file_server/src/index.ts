import { readdir, writeFile } from "node:fs/promises";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { env } from "hono/adapter";
import z from "zod";

import path = require("node:path");

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

app.post(
  "/upload",
  zValidator("form", z.object({ file: z.instanceof(File) })),
  async (c) => {
    const { file } = c.req.valid("form");
    const uploadDir = env(c).UPLOAD_DIR || "./tmp";
    const filePath = path.join(uploadDir, file.name);
    const buffer = await file.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));
    return c.json({});
  },
);
export default app;
