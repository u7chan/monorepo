# Tech Stack

- Bun
- TypeScript
- Hono
- React
- Tailwind CSS v4
- oxlint
- oxfmt

# Commands

- `bun run dev`: Start the development server with watch mode.
- `bun run build`: Bundle the React SPA into `dist/client`.
- `bun run lint`: Run oxlint and fail on warnings.
- `bun run format`: Format files with oxfmt.

# Notes

## Tailwind CSS v4

`@theme` は Tailwind CSS v4 の正しい構文だが、Zed のビルトイン CSS LSP (vscode-css-language-server) が認識せず `Unknown at rule @theme` 警告を出す。Zed で抑制するには `settings.json` に以下を追加する：

```json
{
  "lsp": {
    "vscode-css-language-server": {
      "settings": {
        "css": {
          "unknownAtRules": "ignore"
        }
      }
    }
  }
}
```

または Zed の Extensions から `@tailwindcss/language-server` をインストールする。
