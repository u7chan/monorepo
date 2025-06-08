# portfolio

![TypeScript](https://img.shields.io/badge/TypeScript-v5-3178C6?style=flat&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-v19-61DAFB?style=flat&logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-v6-646CFF?style=flat&logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-38B2AC?style=flat&logo=tailwind-css&logoColor=white)
![TanStack Router](https://img.shields.io/badge/TanStack_Router-v1-FF41B4?style=flat&logo=tanstack&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v17-4169E1?style=flat&logo=postgresql&logoColor=white)
![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-v0-2D87FF?style=flat&logo=drizzle&logoColor=white)

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
|DB|[PostgreSQL](https://www.postgresql.org/)|
|ORM|[Drizzle ORM](https://orm.drizzle.team/)|
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

## Database Migration

- Schema creation (only during the initial setup):

  ```sh
  CREATE DATABASE portfolio;
  ```

- Create migration:

  ```sh
  bun run db:generate
  ```

- Apply migration:

  ```sh
  bun run db:migrate
  ```

- Run Seeders:

  ```sh
  bun run db:seed:users
  ```
