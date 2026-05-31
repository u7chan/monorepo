# projects/ 分類ルール

このドキュメントは、`projects/` 配下の整理判断に使う分類ルールと初期分類表です。
物理移動は別 Issue で扱い、この文書では移動先カテゴリと判断基準だけを固定します。

## 分類カテゴリ

`projects/` 配下の分類は、次の 4 カテゴリに統一します。

| Category | Path | Rule | Examples |
| --- | --- | --- | --- |
| main | `projects/<project>` | deploy 対象、または継続保守するアプリ | `edit-vid`, `file-server`, `portfolio`, `portal`, `simple-agent-poc` |
| labs | `projects/labs/<project>` | 今後も育てる、または再利用する可能性がある実験 | `hono-react-inertia`, `tanstack-start-example`, `nix-example` |
| poc | `projects/poc/<project>` | 特定仮説、Issue、実装案を検証して役目を終えたもの | `backend-sse-chat-poc`, `ai-driven-dev-sample` |
| samples | `projects/samples/<project>` | 教材、テンプレート、CI/CD 検証、公式サンプル改造 | `cicd-ci-sample`, `python-uv`, `react-router-v7-example` |

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

## 初期分類表

#982 で 10件のプロジェクトを `projects/samples/` へ移動しました。残りの samples 行は後続対応です。
#983 で 4件のPoCを `projects/poc/` へ移動しました。
#984 で 8件のlabプロジェクトを `projects/labs/` へ移動しました。

| Project | Initial category | Target path | Note |
| --- | --- | --- | --- |
| `ai-driven-dev-sample` | `poc` | `projects/poc/ai-driven-dev-sample` | AI 駆動開発教材を兼ねた検証済みサンプル（#983 moved） |
| `backend-sse-chat-poc` | `poc` | `projects/poc/backend-sse-chat-poc` | SSE chat のバックエンド検証（#983 moved） |
| `chat-mcp-client` | `poc` | `projects/poc/chat-mcp-client` | MCP client 検証 PoC（#983 moved） |
| `chatbot-ui` | `labs` | `projects/labs/chatbot-ui` | UI 実験として継続判断する |
| `cicd-cd-sample` | `samples` | `projects/samples/cicd-cd-sample` | CD 検証用サンプル |
| `cicd-ci-sample` | `samples` | `projects/samples/cicd-ci-sample` | CI 検証用サンプル |
| `edit-vid` | `main` | `projects/edit-vid` | 継続保守するアプリ |
| `demo-greeting-lib` | `samples` | `projects/samples/demo-greeting-lib` | ライブラリ構成サンプル |
| `demo-math-lib` | `samples` | `projects/samples/demo-math-lib` | ライブラリ構成サンプル |
| `example-reactui-lib` | `samples` | `projects/samples/example-reactui-lib` | React UI ライブラリ構成サンプル |
| `fastapi-api-base` | `samples` | `projects/samples/fastapi-api-base` | FastAPI API ベーステンプレート |
| `fastapi-mcp-server` | `samples` | `projects/samples/fastapi-mcp-server` | FastAPI MCP 構成サンプル |
| `fastmcp-example` | `samples` | `projects/samples/fastmcp-example` | FastMCP 公式/実装例 |
| `file-server` | `main` | `projects/file-server` | 継続保守するアプリ |
| `gemini-sdk-example` | `samples` | `projects/samples/gemini-sdk-example` | SDK 利用サンプル |
| `google-adk-example` | `samples` | `projects/samples/google-adk-example` | ADK 利用サンプル |
| `hiit-timer` | `labs` | `projects/labs/hiit-timer` | 小規模アプリ実験 |
| `hono-htmx-tailwind-server` | `samples` | `projects/samples/hono-htmx-tailwind-server` | Hono/HTMX/Tailwind 構成サンプル |
| `hono-mcp-client` | `samples` | `projects/samples/hono-mcp-client` | Hono MCP client サンプル |
| `hono-mcp-middleware-server` | `samples` | `projects/samples/hono-mcp-middleware-server` | Hono MCP middleware サンプル |
| `hono-mcp-server` | `labs` | `projects/labs/hono-mcp-server` | Hono MCP server サンプル（#984 moved） |
| `hono-node-server` | `samples` | `projects/samples/hono-node-server` | Hono Node server サンプル |
| `hono-openai-client` | `samples` | `projects/samples/hono-openai-client` | Hono OpenAI client サンプル |
| `hono-react-inertia` | `labs` | `projects/labs/hono-react-inertia` | 再利用・発展可能な実験（#984 moved） |
| `hono-simple-client-component` | `samples` | `projects/samples/hono-simple-client-component` | Hono client component サンプル |
| `honox-example-todo-list` | `samples` | `projects/samples/honox-example-todo-list` | HonoX todo サンプル |
| `litellm-proxy-lab` | `labs` | `projects/labs/litellm-proxy-lab` | LiteLLM proxy 構成実験（#984 moved） |
| `long-running-mcp-server` | `samples` | `projects/samples/long-running-mcp-server` | MCP server 構成サンプル |
| `mcp-use-example` | `samples` | `projects/samples/mcp-use-example` | mcp-use 利用サンプル |
| `nix-example` | `labs` | `projects/labs/nix-example` | Nix Python executor 実験（#984 moved） |
| `node-mcp-server` | `samples` | `projects/samples/node-mcp-server` | Node MCP server サンプル |
| `node-mcp-server-remote` | `samples` | `projects/samples/node-mcp-server-remote` | Remote MCP server サンプル |
| `openai-responses-api-example` | `poc` | `projects/poc/openai-responses-api-example` | Responses API 検証 PoC（#983 moved） |
| `portal` | `main` | `projects/portal` | 継続保守するアプリ |
| `portfolio` | `main` | `projects/portfolio` | 継続保守するアプリ |
| `python-uv` | `samples` | `projects/samples/python-uv` | uv/Python 構成サンプル |
| `python-uv-fastapi` | `samples` | `projects/samples/python-uv-fastapi` | uv/FastAPI 構成サンプル |
| `python_docling` | `labs` | `projects/labs/python_docling` | Docling 検証実験 |
| `python_word_analyzer` | `labs` | `projects/labs/python_word_analyzer` | Word 解析実験 |
| `react-markdown-preview` | `labs` | `projects/labs/react-markdown-preview` | UI/preview 実験 |
| `react-router-v7-example` | `samples` | `projects/samples/react-router-v7-example` | React Router v7 サンプル |
| `simple-agent-poc` | `main` | `projects/simple-agent-poc` | PoC 名だが継続保守対象 |
| `tanstack-start-example` | `labs` | `projects/labs/tanstack-start-example` | 再利用・発展可能な実験（#984 moved） |
| `threejs-obj-viewer` | `labs` | `projects/labs/threejs-obj-viewer` | Three.js viewer 実験（#984 moved） |
| `u7agent` | `labs` | `projects/labs/u7agent` | deploy 対象の agent アプリ（#984 moved） |
| `u7chat` | `labs` | `projects/labs/u7chat` | deploy 対象の chat アプリ（#984 moved） |
| `workspace-consumer-demo` | `samples` | `projects/samples/workspace-consumer-demo` | workspace 利用デモ |
