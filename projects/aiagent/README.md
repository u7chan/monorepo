# aiagent

Hono + Bun の Web アプリケーション。

## 開発

```sh
bun install
bun run dev
```

## チェック

```sh
bun run lint   # tsc --noEmit + biome lint
bun run test   # bun test
```

## Docker

```sh
docker build -t aiagent --target=test .   # CI相当(lint + test)
docker build -t aiagent .                 # 本番イメージ(final)
docker run -p 3000:3000 aiagent
```
