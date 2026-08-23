- リポジトリ共通の規約（ブランチ運用など）は [ルートの AGENTS.md](../../AGENTS.md) を参照

## Tech Stack

- Bun
- TypeScript
- Hono
- Pi (`@earendil-works/pi-coding-agent`)

## Why / What / Constraints First

実装前に、必要に応じて以下を簡潔に明確にすること。

- **Why**: なぜ必要か
- **What**: 何を満たすべきか
- **Constraints**: 守るべき前提・制約

**How** は実装方法そのものを指すため、ここには含めない。  
How は設計とコードで表現すること。

## Test Policy

テストケースは生きるドキュメント(仕様書)として設計してください。

## Comment Policy

- ドキュメントコメントは書かない (膨らみ、コードと矛盾するため)
- 意図・前提は対象箇所に 1 行コメント、将来の改善は `// TODO:` / `// TBD:` で残す

## Review Policy

レビューコメントやレビュー結果は、常に日本語で記述してください。

## References

タスクの目的や変更範囲に応じて、以下を参照してください。

- [docs/testing.md](docs/testing.md) - テストの方針と約束事（createApp() 経由など）
