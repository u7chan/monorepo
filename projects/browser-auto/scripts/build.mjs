await Bun.$`bunx tailwindcss -i src/client/app.css -o dist/client/app.css`
await Bun.$`bun build src/client/app.tsx --outdir dist/client --minify --production`
await Bun.$`cp src/client/index.html dist/client/index.html`
