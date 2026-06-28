# browser-auto

## Setup

```bash
# Install dependencies
bun install

# Install Chromium for Playwright
bunx playwright install chromium

# Start the development server
bun run dev
```

## YAML Definitions

### Site (`definitions/sites/*.yaml`)

```yaml
schemaVersion: 1
id: local
name: Local Browser Auto
baseUrl: http://127.0.0.1:3000
```

| Field         | Type   | Description            |
| ------------- | ------ | ---------------------- |
| schemaVersion | `1`    | Fixed value            |
| id            | string | Unique site identifier |
| name          | string | Human-readable name    |
| baseUrl       | string | Base URL of the site   |

### Scenario (`definitions/scenarios/*.yaml`)

```yaml
schemaVersion: 1
id: smoke
name: Smoke Test
siteId: local
steps:
  - action: goto
    path: /
  - action: assertVisible
    locator:
      text: Browser Auto
```

Supported actions:

- `goto` — Navigate to `{baseUrl}{path}`. `path` must start with `/`.
- `assertVisible` — Wait for an element with matching text to become visible using `exact` text matching.

Each step times out after 30 seconds. YAML files are loaded at server startup only (no hot reload).

## API

### Start a run

```http
POST /api/runs
Content-Type: application/json

{"scenarioId": "smoke"}
```

```bash
# Start a smoke test run and poll for completion
RUN=$(curl -sS -X POST http://127.0.0.1:3000/api/runs -H 'Content-Type: application/json' -d '{"scenarioId":"smoke"}')
RUN_ID=$(echo "$RUN" | head -1 | sed 's/.*"runId":"\([^"]*\)".*/\1/')
echo "Started $RUN_ID"
while :; do
  STATUS=$(curl -sS "http://127.0.0.1:3000/api/runs/$RUN_ID")
  echo "$STATUS"
  echo "$STATUS" | grep -q '"running"' || break
  sleep 1
done
```

Response (202 Accepted):

```json
{ "runId": "d290f1ee-6c54-4b01-90e6-d701748f0851", "status": "running" }
```

Status codes:

- `202` — Accepted and running
- `400` — Invalid JSON or missing `scenarioId`
- `404` — Unknown scenario ID
- `409` — A run is already in progress

### Check run status

```http
GET /api/runs/:runId
```

Response:

```json
{
  "runId": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "scenarioId": "smoke",
  "status": "succeeded",
  "stepIndex": null,
  "startedAt": "2026-01-01T00:00:00.000Z",
  "finishedAt": "2026-01-01T00:00:05.000Z",
  "error": null
}
```

Status codes:

- `200` — Run found
- `404` — Run not found (expired or never existed)

## Docker

Docker-based Playwright execution is out of scope at this stage. Run the server directly with Bun for browser automation.
