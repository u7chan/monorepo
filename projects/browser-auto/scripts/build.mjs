import { execSync } from "node:child_process"

execSync("bunx tailwindcss -i src/client/app.css -o dist/client/app.css", {
  stdio: "inherit",
})
execSync("bun build src/client/app.tsx --outdir dist/client --minify --production", {
  stdio: "inherit",
})
execSync("cp src/client/index.html dist/client/index.html", {
  stdio: "inherit",
})
