"""Application use cases."""

import time
from collections.abc import Generator
from datetime import datetime
from uuid import uuid4

from simple_agent_poc.application.dto import (
    ContentDelta,
    RunAgentRequest,
    RunAgentResponse,
    StreamComplete,
    ToolCallEvent,
    ToolResultEvent,
)
from simple_agent_poc.application.ports import (
    LLMClientFactory,
    SessionStore,
    ToolExecutor,
)
from simple_agent_poc.core.agent_definition import (
    AgentDefinition,
    AgentDefinitionRegistry,
)
from simple_agent_poc.core.session import ConversationSession
from simple_agent_poc.core.types import (
    LLMError,
    SessionNotFoundError,
    ToolCall,
    ToolCallDelta,
    Usage,
    ValidationError,
)

MAX_TOOL_ROUNDS = 5


def _accumulate_tool_call_chunks(
    accumulated: dict[int, ToolCall],
    td: ToolCallDelta,
) -> None:
    idx = td["index"]
    if idx not in accumulated:
        accumulated[idx] = {
            "id": "",
            "type": "function",
            "function": {"name": "", "arguments": ""},
        }
    acc = accumulated[idx]
    tid = td.get("id")
    if tid:
        acc["id"] = tid
    fn_delta = td["function"]
    fn_name = fn_delta.get("name")
    if fn_name:
        acc["function"]["name"] += fn_name
    fn_args = fn_delta.get("arguments")
    if fn_args:
        acc["function"]["arguments"] += fn_args


class RunAgentUseCase:
    """Reusable execution path for session-aware agent interactions."""

    def __init__(
        self,
        *,
        llm_client_factory: LLMClientFactory,
        session_store: SessionStore,
        agent_definitions: AgentDefinitionRegistry,
        tool_executor: ToolExecutor | None = None,
    ) -> None:
        self._llm_client_factory = llm_client_factory
        self._session_store = session_store
        self._agent_definitions = agent_definitions
        self._tool_executor = tool_executor

    def execute(self, request: RunAgentRequest) -> RunAgentResponse:
        """Run the agent for a single user message with ReAct tool loop."""
        if not request.message.strip():
            raise ValidationError("message must not be blank")

        agent_definition = self._agent_definitions.get(request.agent_id)
        session = self._load_session(
            request.session_id,
            agent_definition=agent_definition,
        )
        if session.agent_id != agent_definition.agent_id:
            raise ValidationError("agent_id cannot be changed for an existing session")
        session.append_user_message(request.message)

        llm_client = self._llm_client_factory(agent_definition)
        tools = self._resolve_tools(agent_definition)

        for _ in range(MAX_TOOL_ROUNDS):
            response = llm_client.complete(list(session.messages), tools=tools)

            tool_calls = response.get("tool_calls")
            if not tool_calls:
                session.append_assistant_message(response["content"])
                self._session_store.save(session)
                return RunAgentResponse.from_llm_response(
                    response,
                    session_id=session.session_id,
                )

            if self._tool_executor is None:
                raise LLMError(
                    "Tool call requested but no tool executor configured",
                    display_message="Tool call requested but no tool executor configured.",
                )
            session.append_assistant_message(
                response["content"] or "", tool_calls=tool_calls
            )
            for tc in tool_calls:
                result = self._tool_executor.execute(tc)
                session.append_tool_message(result, tool_call_id=tc["id"])

        raise LLMError(
            "Exceeded maximum tool call rounds",
            display_message="Exceeded maximum tool call rounds.",
        )

    def execute_stream(
        self, request: RunAgentRequest
    ) -> Generator[ContentDelta | ToolCallEvent | ToolResultEvent | StreamComplete]:
        """Run the agent for a single user message with streaming ReAct loop."""
        if not request.message.strip():
            raise ValidationError("message must not be blank")

        agent_definition = self._agent_definitions.get(request.agent_id)
        session = self._load_session(
            request.session_id,
            agent_definition=agent_definition,
        )
        if session.agent_id != agent_definition.agent_id:
            raise ValidationError("agent_id cannot be changed for an existing session")
        session.append_user_message(request.message)

        llm_client = self._llm_client_factory(agent_definition)
        tools = self._resolve_tools(agent_definition)
        model = agent_definition.model
        _start_time = time.perf_counter()
        _accumulated_text = ""

        try:
            for round_idx in range(MAX_TOOL_ROUNDS):
                _accumulated_text = ""
                accumulated_tool_calls: dict[int, ToolCall] = {}
                usage_from_stream: Usage | None = None

                for chunk in llm_client.complete_stream(
                    list(session.messages), tools=tools
                ):
                    delta = chunk.get("content_delta")
                    if delta:
                        _accumulated_text += delta
                        yield ContentDelta(delta=delta)

                    td = chunk.get("tool_call_delta")
                    if td is not None:
                        _accumulate_tool_call_chunks(accumulated_tool_calls, td)

                    if "usage" in chunk:
                        usage_from_stream = chunk["usage"]

                if accumulated_tool_calls:
                    if self._tool_executor is None:
                        raise LLMError(
                            "Tool call requested but no tool executor configured",
                            display_message="Tool call requested but no tool executor configured.",
                        )
                    tool_calls = [
                        accumulated_tool_calls[i]
                        for i in sorted(accumulated_tool_calls)
                    ]
                    for tc in tool_calls:
                        yield ToolCallEvent(
                            call_id=tc["id"],
                            name=tc["function"]["name"],
                            arguments=tc["function"]["arguments"],
                        )

                    session.append_assistant_message(
                        _accumulated_text, tool_calls=tool_calls
                    )

                    for tc in tool_calls:
                        result = self._tool_executor.execute(tc)
                        session.append_tool_message(result, tool_call_id=tc["id"])
                        yield ToolResultEvent(
                            call_id=tc["id"],
                            name=tc["function"]["name"],
                            result=result,
                        )
                else:
                    session.append_assistant_message(_accumulated_text)
                    elapsed = time.perf_counter() - _start_time
                    yield StreamComplete(
                        session_id=session.session_id,
                        usage=usage_from_stream,
                        model=model,
                        response_time=elapsed,
                    )
                    return

            raise LLMError(
                "Exceeded maximum tool call rounds",
                display_message="Exceeded maximum tool call rounds.",
            )
        except Exception:
            if _accumulated_text:
                session.append_assistant_message(
                    f"{_accumulated_text}\n\n[stream interrupted]"
                )
            else:
                session.append_assistant_message("[stream interrupted]")
            raise
        finally:
            self._session_store.save(session)

    def _load_session(
        self,
        session_id: str | None,
        *,
        agent_definition: AgentDefinition,
    ) -> ConversationSession:
        if session_id is None:
            return ConversationSession.start(
                session_id=uuid4().hex,
                agent_id=agent_definition.agent_id,
                system_prompt=agent_definition.format_system_prompt(
                    current_datetime=datetime.now().isoformat()
                ),
            )

        session = self._session_store.get(session_id)
        if session is None:
            raise SessionNotFoundError(
                f"Session not found: {session_id}",
                display_message="Session not found.",
            )
        return session

    def _resolve_tools(self, agent_definition: AgentDefinition) -> list | None:
        if not self._tool_executor or not agent_definition.tools:
            return None
        return self._tool_executor.get_definitions(agent_definition.tools)
