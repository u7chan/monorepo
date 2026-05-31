# projects/ 分類ルール

このドキュメントは、`projects/` 配下の整理判断に使う分類ルールです。
移動先カテゴリ、判断基準、現在の配置台帳を固定します。

## 分類カテゴリ

`projects/` 配下の分類は、次の 4 カテゴリに統一します。

| Category | Path | Rule | Examples |
| --- | --- | --- | --- |
| main | `projects/<project>` | deploy 対象、または継続保守するアプリ/ライブラリ | `chatbot-ui`, `edit-vid`, `file-server`, `portfolio`, `portal`, `simple-agent-poc` |
| labs | `projects/labs/<project>` | 今後も育てる、または再利用する可能性がある実験 | `hiit-timer`, `hono-react-inertia`, `long-running-mcp-server`, `tanstack-start-example` |
| poc | `projects/poc/<project>` | 特定仮説、Issue、実装案を検証して役目を終えたもの | `backend-sse-chat-poc`, `hono-openai-client`, `python_docling` |
| samples | `projects/samples/<project>` | 教材、テンプレート、CI/CD 検証、公式サンプル改造 | `fastapi-api-base`, `gemini-sdk-example`, `react-markdown-preview` |

`poc` は単数形カテゴリとして採用します。`pocs` や `proofs-of-concept` は使いません。

## 階層ルール

分類後のサブ階層は `projects/<category>/<project>` までに限定します。

```text
projects/...          # main: 現役/継続保守
projects/labs/...     # labs: 再利用・発展可能な実験
projects/poc/...      # poc: 検証完了した PoC/参考資料
projects/samples/...  # samples: 教材/テンプレ/CI 検証
```

`projects/labs/frontend/<project>` のようにカテゴリ配下へ追加の分類階層を作らず、必要な補足は README やこの台帳の Note に書きます。

## 判断順

分類に迷う場合は、次の順に判断します。

1. deploy 対象、または継続保守対象なら `main`
2. 今後も発展させる実験なら `labs`
3. 検証済みで参考資料として残すなら `poc`
4. 教材、テンプレート、公式サンプル改造、CI/CD 検証なら `samples`

Dockerfile の `final` stage があるだけでは `main` とは判断しません。CI/CD 検証用やテンプレート用の Dockerfile は `samples` に分類します。

## 現在の分類台帳

| Category | Projects |
| --- | --- |
| main | `chatbot-ui`, `edit-vid`, `file-server`, `portfolio`, `portal`, `simple-agent-poc` |
| labs | `hiit-timer`, `hono-mcp-server`, `hono-react-inertia`, `litellm-proxy-lab`, `long-running-mcp-server`, `nix-example`, `tanstack-start-example`, `threejs-obj-viewer`, `u7agent`, `u7chat` |
| poc | `ai-driven-dev-sample`, `backend-sse-chat-poc`, `chat-mcp-client`, `execution-sandbox`, `hono-mcp-client`, `hono-openai-client`, `openai-responses-api-example`, `python_docling`, `python_word_analyzer` |
| samples | `cicd-cd-sample`, `cicd-ci-sample`, `demo-greeting-lib`, `demo-math-lib`, `example-reactui-lib`, `fastapi-api-base`, `fastapi-mcp-server`, `fastmcp-example`, `gemini-sdk-example`, `google-adk-example`, `hono-htmx-tailwind-server`, `hono-mcp-middleware-server`, `hono-node-server`, `hono-simple-client-component`, `honox-example-todo-list`, `mcp-use-example`, `node-mcp-server`, `node-mcp-server-remote`, `python-uv`, `python-uv-fastapi`, `react-markdown-preview`, `react-router-v7-example`, `workspace-consumer-demo` |
