import { spawn, execSync } from "node:child_process"
import { watch } from "node:fs"

function copyHtml() {
  execSync("cp src/client/index.html dist/client/index.html", { stdio: "inherit" })
}

function buildJs() {
  try {
    execSync("bun build src/client/app.tsx --outdir dist/client --minify --production", {
      stdio: "inherit",
    })
  } catch {
    // build failed, keep watching
  }
}

copyHtml()
buildJs()

watch("src/client", { recursive: true }, (_event, filename) => {
  if (filename?.endsWith(".tsx") || filename?.endsWith(".ts")) {
    buildJs()
  }
  if (filename?.endsWith(".html")) {
    copyHtml()
  }
})

const processes = [
  spawn(
    "bunx",
    ["tailwindcss", "-i", "src/client/app.css", "-o", "dist/client/app.css", "--watch"],
    {
      stdio: "inherit",
    },
  ),
  spawn("bun", ["--watch", "src/server/bun-server.ts"], { stdio: "inherit" }),
]

function cleanup() {
  for (const proc of processes) {
    proc.kill("SIGTERM")
  }
}

process.on("SIGINT", cleanup)
process.on("SIGTERM", cleanup)

for (const proc of processes) {
  proc.on("exit", (code) => {
    if (code !== null && code !== 0) {
      cleanup()
      process.exit(code)
    }
  })
}
