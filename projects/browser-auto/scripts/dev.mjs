import { watch, mkdirSync } from "node:fs"

async function copyHtml() {
  mkdirSync("dist/client", { recursive: true })
  await Bun.$`cp src/client/index.html dist/client/index.html`
}

async function buildJs() {
  try {
    await Bun.$`bun build src/client/app.tsx --outdir dist/client --minify --production`
  } catch {
    // build failed, keep watching
  }
}

await copyHtml()
await buildJs()

let buildQueue = Promise.resolve()

function queueBuild() {
  buildQueue = buildQueue.then(() => buildJs())
  return buildQueue
}

watch("src/client", { recursive: true }, (_event, filename) => {
  if (filename?.endsWith(".tsx") || filename?.endsWith(".ts")) {
    void queueBuild()
  }
  if (filename?.endsWith(".html")) {
    void copyHtml()
  }
})

const processes = [
  Bun.spawn(
    ["bunx", "tailwindcss", "-i", "src/client/app.css", "-o", "dist/client/app.css", "--watch"],
    {
      stdio: ["inherit", "inherit", "inherit"],
    },
  ),
  Bun.spawn(["bun", "--watch", "src/server/bun-server.ts"], {
    stdio: ["inherit", "inherit", "inherit"],
  }),
]

function cleanup() {
  for (const proc of processes) {
    proc.kill("SIGTERM")
  }
}

process.on("SIGINT", cleanup)
process.on("SIGTERM", cleanup)

for (const proc of processes) {
  void proc.exited.then((code) => {
    if (proc.signalCode === null && code !== 0) {
      cleanup()
      process.exit(code)
    }
  })
}
