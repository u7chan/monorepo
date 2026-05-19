---
name: agent-cli-debug
description: CLI-first live debugging workflow for simple-agent-poc agent behavior. Use when investigating LLM/tool behavior, ask_user pause/resume flows, repeated tool-call loops, model quality differences, ReAct orchestration, or before modifying code based on observed agent behavior; prefer CLI verification over web or headless-browser checks unless the defect is specifically browser UI rendering or HTTP/SSE behavior.
---

# Agent CLI Debug

Use the project CLI to reproduce agent behavior before changing code. This keeps debugging close to the LLM/tool loop without spending tokens on browser automation or UI-only inspection.

## Workflow

1. Read the relevant docs first:
   - CLI behavior: [docs/cli.md](../../../docs/cli.md)
   - Tests and quality commands: [docs/testing.md](../../../docs/testing.md)
   - For LLM/tool/session changes, also follow AGENTS.md task mapping.

2. Reproduce in CLI before editing:
   - Run `uv run dev` for the default agent.
   - Run `uv run dev --agent <agent-id>` for the agent under investigation.
   - Use the user's exact prompt when available.
   - For `ask_user`, answer through the CLI prompt exactly as a user would.
   - Continue until the agent returns a final answer, pauses again, or raises an error.

3. Compare behavior when model or agent differences matter:
   - Run the same prompt against the known-good agent and the failing agent.
   - Keep the prompt, answers, final response, repeated tool calls, and error text.
   - Do not infer a model-specific loop from code alone when the CLI can confirm it.

4. Turn the transcript into a narrow hypothesis:
   - Identify whether the issue is in tool arguments, tool result formatting, session resume, streamed function call IDs, tool availability, or prompt/model behavior.
   - Inspect only the code paths needed for that hypothesis.
   - Preserve user-visible output unless the requested fix requires changing it.

5. Verify with the same CLI scenario after the change:
   - Re-run the failing prompt and answer sequence.
   - Confirm the previous loop/error no longer occurs.
   - When useful, run a control case with the default agent to catch regressions.

6. Back the manual result with tests:
   - Add or update focused unit tests for the code path that caused the CLI behavior.
   - Run targeted tests first, then project checks when scope warrants:
     - `uv run ruff check .`
     - `uv run ruff format --check .`
     - `uv run ty check`
     - `uv run pytest`

## CLI Session Notes

- Use an interactive terminal session for `uv run dev` and send user input line by line.
- Stop any long-running CLI session after gathering the transcript needed for the task.
- Prefer CLI over browser/headless checks for LLM quality, tool loops, and `ask_user` behavior.
- Use browser or HTTP/SSE checks only when the issue is about web UI state, rendering, disabled controls, layout, or API streaming transport.

## Report

When summarizing the fix, include:

- The CLI scenario used for reproduction.
- The before/after behavior.
- The test commands run.
- Any remaining case that was not covered by CLI verification.
