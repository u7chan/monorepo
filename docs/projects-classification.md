# projects/ 分類ルール

このドキュメントは、`projects/` 配下の整理判断に使う分類ルールです。
移動先カテゴリ、判断基準、現在の配置台帳を固定します。

## 分類カテゴリ

`projects/` 配下の分類は、次の 3 カテゴリに統一します。

| Category | Path | Rule | Examples |
| --- | --- | --- | --- |
| main | `projects/<project>` | deploy 対象、または継続保守するアプリ/ライブラリ | `edit-vid`, `file-server`, `portfolio`, `portal`, `raw-webgl2-shader`, `simple-agent-poc` |
| labs | `projects/_labs/<project>` | 今後も育てる、または再利用する可能性がある実験。PoC もここに含める | `backend-sse-chat-poc`, `chatbot-ui`, `hono-react-inertia`, `long-running-mcp-server` |
| samples | `projects/_samples/<project>` | 教材、テンプレート、CI/CD 検証、公式サンプル改造 | `fastapi-api-base`, `gemini-sdk-example`, `react-markdown-preview` |

`poc` は独立した配置カテゴリとしては使いません。

## 階層ルール

分類後のサブ階層は `projects/<category>/<project>` までに限定します。

```text
projects/...          # main: 現役/継続保守
projects/_labs/...     # labs: 再利用・発展可能な実験/PoC
projects/_samples/...  # samples: 教材/テンプレ/CI 検証
```

`projects/_labs/frontend/<project>` のようにカテゴリ配下へ追加の分類階層を作らず、必要な補足は README やこの台帳の Note に書きます。

## 判断順

分類に迷う場合は、次の順に判断します。

1. deploy 対象、または継続保守対象なら `main`
2. 今後も発展させる実験なら `labs`
3. 教材、テンプレート、公式サンプル改造、CI/CD 検証なら `samples`

Dockerfile の `final` stage があるだけでは `main` とは判断しません。CI/CD 検証用やテンプレート用の Dockerfile は `samples` に分類します。

## 現在の分類台帳

| Category | Projects |
| --- | --- |
| main | `edit-vid`, `file-server`, `portfolio`, `portal`, `raw-webgl2-shader`, `simple-agent-poc` |
| labs | `backend-sse-chat-poc`, `chat-mcp-client`, `chatbot-ui`, `execution-sandbox`, `hiit-timer`, `hono-mcp-server`, `hono-react-inertia`, `litellm-proxy-lab`, `long-running-mcp-server`, `python_docling`, `python_word_analyzer`, `threejs-obj-viewer`, `u7agent`, `u7chat` |
| samples | `ai-driven-dev-sample`, `cicd-cd-sample`, `cicd-ci-sample`, `demo-greeting-lib`, `demo-math-lib`, `example-reactui-lib`, `fastapi-api-base`, `fastapi-mcp-server`, `fastmcp-example`, `gemini-sdk-example`, `google-adk-example`, `hono-htmx-tailwind-server`, `hono-mcp-client`, `hono-mcp-middleware-server`, `hono-node-server`, `hono-openai-client`, `hono-simple-client-component`, `honox-example-todo-list`, `mcp-use-example`, `nix-example`, `node-mcp-server`, `node-mcp-server-remote`, `openai-responses-api-example`, `python-uv`, `python-uv-fastapi`, `react-markdown-preview`, `react-router-v7-example`, `tanstack-start-example`, `workspace-consumer-demo` |
