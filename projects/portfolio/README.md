# portfolio

![TypeScript](https://img.shields.io/badge/TypeScript-v5-3178C6?style=flat&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-v19-61DAFB?style=flat&logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-v6-646CFF?style=flat&logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-38B2AC?style=flat&logo=tailwind-css&logoColor=white)
![TanStack Router](https://img.shields.io/badge/TanStack_Router-v1-FF41B4?style=flat&logo=tanstack&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v17-4169E1?style=flat&logo=postgresql&logoColor=white)
![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-v0-2D87FF?style=flat&logo=drizzle&logoColor=white)

## Architectures

| #                   | tech                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Language            | [TypeScript](https://www.typescriptlang.org/)                                              |
| Runtime             | [Node](https://nodejs.org/)                                                                |
| Package Manager     | [Bun](https://bun.sh/)                                                                     |
| Linter & Formatter  | [Oxlint / Oxfmt](https://oxc.rs/docs/guide/introduction.html)                              |
| CSS Styling         | [Tailwind CSS](https://tailwindcss.com/)                                                   |
| Build & Bundler     | [Vite](https://ja.vite.dev/)                                                               |
| Frontend            | [React](https://react.dev/) (Single Page Application)                                      |
| Frontend routing    | [TanStack Router](https://tanstack.com/router/latest/docs/framework/react/overview)        |
| DB                  | [PostgreSQL](https://www.postgresql.org/)                                                  |
| ORM                 | [Drizzle ORM](https://orm.drizzle.team/)                                                   |
| Develop environment | [Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers) (for VSCode) |

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

- Generate password hash for auth seed:

  ```sh
  node -e "const { randomBytes, scryptSync } = require('node:crypto'); const password = process.argv[1]; const salt = randomBytes(16); const N = 16384; const r = 8; const p = 1; const hash = scryptSync(password, salt, 64, { N, r, p }); console.log(\`scrypt$N=\${N},r=\${r},p=\${p}$\${salt.toString('base64')}$\${hash.toString('base64')}\`)" 'replace-with-password'
  ```

- Upsert auth user after migration:

  ```sh
  AUTH_SEED_EMAIL=test@example.com \
  AUTH_SEED_PASSWORD_HASH='replace-with-generated-hash' \
  bun run db:seed:users
  ```

## Authentication Notes

- Sign-in verifies the password against `users.password_hash`.
- `AUTH_SEED_EMAIL` and `AUTH_SEED_PASSWORD_HASH` are used only when seeding or updating the initial auth user.
- Chat settings `apiKey` is stored in browser `localStorage`. It is not a secure secret store.
