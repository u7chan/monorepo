# portfolio

## Architectures

|#|tech|
|-|-|
|Language|[TypeScript](https://www.typescriptlang.org/)|
|Runtime|[Node](https://nodejs.org/)|
|Package Manager|[Bun](https://bun.sh/)|
|Linter & Formatter|[Biome](https://biomejs.dev/)|
|CSS Styling|[Tailwind CSS](https://tailwindcss.com/)|
|Build & Bundler|[Vite](https://ja.vite.dev/)|
|Frontend|[React](https://react.dev/) (Single Page Application)|
|Frontend routing|[TanStack Router](https://tanstack.com/router/latest/docs/framework/react/overview)|
|Develop environment|[Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers) (for VSCode)|

## Commands

- Run:

  ```sh
  bun run dev
  ```

  open <http://localhost:3000/>

- Lint:

  ```sh
  bun run lint
  ```

- Format:

  ```sh
  bun run format
  ```

- TypeGen:

  ```sh
  bun run typegen
  ```

- Build:

  ```sh
  bun run build
  ```

- Start with built artifacts:

  ```sh
  bun run start
  ```

  open <http://localhost:3000/>

## Deploy

- Image build:

  ```sh
  docker build -t portfolio .
  ```

- Run container:

  ```sh
  SERVER_PORT=3000; \
  docker run \
    -p 3000:3000 \
    -itd \
    --restart=always \
    --env SERVER_PORT=$SERVER_PORT \
    portfolio
  ```
