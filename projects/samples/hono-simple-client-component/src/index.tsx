import { Hono } from "hono";
import { serveStatic } from "hono/bun";

const app = new Hono();
app.use("/static/client.js", serveStatic({ path: "./dist/client.js" }));

app.get("/", (c) => {
  return c.html(
    <>
      <div id="root" />
      <script type="module" src="static/client.js" />
    </>
  );
});

export default app;
