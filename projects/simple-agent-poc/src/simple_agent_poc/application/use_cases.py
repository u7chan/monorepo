"""Application use cases."""

import json
import time
from collections.abc import Generator
from datetime import datetime, timezone
from uuid import uuid4

from simple_agent_poc.application.dto import (
    ContentDelta,
    ContinueRequest,
    RunAgentPaused,
    RunAgentRequest,
    RunAgentResponse,
    SessionPaused,
    StreamComplete,
    ToolCallEvent,
    ToolCallRecord,
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
    SessionNotPausedError,
    ToolCall,
    ToolCallDelta,
    ToolDefinition,
    Usage,
    ValidationError,
)


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


def _find_next_unanswered_ask_user(
    session: ConversationSession,
) -> ToolCall | None:
    """Find the next ask_user tool call in the latest unfinished tool batch."""
    for idx in range(len(session.messages) - 1, -1, -1):
        message = session.messages[idx]
        tool_calls = message.get("tool_calls")
        if message["role"] != "assistant" or not tool_calls:
            continue

        answered_tool_call_ids = {
            msg["tool_call_id"]
            for msg in session.messages[idx + 1 :]
            if msg["role"] == "tool" and "tool_call_id" in msg
        }
        for tool_call in tool_calls:
            if (
                tool_call["id"] not in answered_tool_call_ids
                and tool_call["function"]["name"] == "ask_user"
            ):
                return tool_call
        return None

    return None


def _build_ask_user_result(user_answer: str, questions: list[dict]) -> str:
    """Build the ask_user tool result JSON from the user's raw answer.

    For ``choice`` questions with ``options``, numeric inputs are mapped to
    option labels.  Comma-separated numbers are supported when ``multiSelect``
    is ``True``.  Non-numeric input falls back to free-form text.
    """
    if not questions:
        return json.dumps({"answers": {}}, ensure_ascii=False)
    q = questions[0]
    question_text = q.get("question", "")
    options = q.get("options", [])

    if not options:
        return json.dumps({"answers": {question_text: user_answer}}, ensure_ascii=False)

    multi_select = q.get("multiSelect", False)
    if multi_select:
        parts = [p.strip() for p in user_answer.split(",") if p.strip()]
    else:
        parts = [user_answer.strip()] if user_answer.strip() else []

    if all(p.isdigit() for p in parts):
        labels: list[str] = []
        for p in parts:
            idx = int(p) - 1
            if 0 <= idx < len(options):
                labels.append(options[idx]["label"])
        if labels:
            return json.dumps(
                {"answers": {question_text: ", ".join(labels)}},
                ensure_ascii=False,
            )

    return json.dumps({"answers": {question_text: user_answer}}, ensure_ascii=False)


class RunAgentUseCase:
    """Reusable execution path for session-aware agent interactions."""

    def __init__(
        self,
        *,
        llm_client_factory: LLMClientFactory,
        session_store: SessionStore,
        agent_definitions: AgentDefinitionRegistry,
        tool_executor: ToolExecutor | None = None,
        is_api_context: bool = False,
    ) -> None:
        self._llm_client_factory = llm_client_factory
        self._session_store = session_store
        self._agent_definitions = agent_definitions
        self._tool_executor = tool_executor
        self._is_api_context = is_api_context

    def execute(self, request: RunAgentRequest) -> RunAgentResponse | RunAgentPaused:
        """Run the agent for a single user message with ReAct tool loop.

        Returns ``RunAgentPaused`` when an ``ask_user`` tool call is encountered,
        so the caller can provide an answer via ``continue_sync()``.
        """
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

        tool_call_history: list[ToolCallRecord] = []

        try:
            return self._run_react_loop(
                session=session,
                start_round=0,
                tool_call_history=tool_call_history,
            )
        finally:
            self._session_store.save(session)

    def continue_sync(
        self, request: ContinueRequest
    ) -> RunAgentResponse | RunAgentPaused:
        """Resume a paused session synchronously with the user's answer."""
        session = self._session_store.get(request.session_id)
        if session is None:
            raise SessionNotFoundError(
                f"Session not found: {request.session_id}",
                display_message="Session not found.",
            )
        if not session.is_paused:
            raise SessionNotPausedError(
                f"Session {request.session_id} is not in a paused state",
                display_message="Session is not in a paused state.",
            )

        tc = session.pending_tool_call
        if tc is None:
            raise RuntimeError("Session is paused but no pending tool call found")
        pending_args = json.loads(tc["function"]["arguments"])
        questions = pending_args.get("questions", [])
        result = _build_ask_user_result(request.answer, questions)
        session.replace_tool_message(result, tool_call_id=tc["id"])
        resume_round = session.pending_round
        session.resume_with_answer()

        tool_call_history: list[ToolCallRecord] = []

        next_ask_user_tc = _find_next_unanswered_ask_user(session)
        if next_ask_user_tc is not None:
            session.append_tool_message("", tool_call_id=next_ask_user_tc["id"])
            return self._build_paused_result(
                session=session,
                ask_user_tc=next_ask_user_tc,
                round_idx=resume_round,
                tool_call_history=tool_call_history,
            )

        try:
            return self._run_react_loop(
                session=session,
                start_round=resume_round + 1,
                tool_call_history=tool_call_history,
            )
        finally:
            self._session_store.save(session)

    def _run_react_loop(
        self,
        *,
        session: ConversationSession,
        start_round: int,
        tool_call_history: list[ToolCallRecord],
    ) -> RunAgentResponse | RunAgentPaused:
        agent_definition = self._agent_definitions.get(session.agent_id)
        llm_client = self._llm_client_factory(agent_definition)
        tools = self._resolve_tools(agent_definition)

        for round_idx in range(start_round, agent_definition.max_tool_rounds):
            response = llm_client.complete(list(session.messages), tools=tools)

            tool_calls = response.get("tool_calls")
            if not tool_calls:
                session.append_assistant_message(response["content"])
                return RunAgentResponse.from_llm_response(
                    response,
                    session_id=session.session_id,
                    tool_call_history=tool_call_history,
                )

            if self._tool_executor is None:
                raise LLMError(
                    "Tool call requested but no tool executor configured",
                    display_message="Tool call requested but no tool executor configured.",
                )
            session.append_assistant_message(
                response["content"] or "", tool_calls=tool_calls
            )

            ask_user_tcs = [
                tc for tc in tool_calls if tc["function"]["name"] == "ask_user"
            ]
            for tc in tool_calls:
                if tc["function"]["name"] == "ask_user":
                    continue
                result = self._tool_executor.execute(tc)
                session.append_tool_message(result, tool_call_id=tc["id"])
                tool_call_history.append(
                    ToolCallRecord(
                        call_id=tc["id"],
                        name=tc["function"]["name"],
                        arguments=tc["function"]["arguments"],
                        result=result,
                    )
                )

            if ask_user_tcs:
                # Add a placeholder tool message so OpenAI's history validation
                # is satisfied when the session resumes later.
                session.append_tool_message("", tool_call_id=ask_user_tcs[0]["id"])
                return self._build_paused_result(
                    session=session,
                    ask_user_tc=ask_user_tcs[0],
                    round_idx=round_idx,
                    tool_call_history=tool_call_history,
                )

        raise LLMError(
            "Exceeded maximum tool call rounds",
            display_message="Exceeded maximum tool call rounds.",
        )

    def execute_stream(
        self, request: RunAgentRequest
    ) -> Generator[
        ContentDelta | ToolCallEvent | ToolResultEvent | SessionPaused | StreamComplete,
        str | None,
        None,
    ]:
        """Run the agent for a single user message with streaming ReAct loop.

        When the LLM calls the ask_user tool and is_api_context is False,
        the generator pauses via ``yield ToolCallEvent(...)``. The caller
        must inject the user's answer by calling ``generator.send(answer)``.
        """
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
            for round_idx in range(agent_definition.max_tool_rounds):
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

                    ask_user_tc = next(
                        (
                            tc
                            for tc in tool_calls
                            if tc["function"]["name"] == "ask_user"
                        ),
                        None,
                    )
                    session.append_assistant_message(
                        _accumulated_text, tool_calls=tool_calls
                    )

                    if ask_user_tc and self._is_api_context:
                        for tc in tool_calls:
                            yield ToolCallEvent(
                                call_id=tc["id"],
                                name=tc["function"]["name"],
                                arguments=tc["function"]["arguments"],
                            )
                        for tc in tool_calls:
                            if tc["function"]["name"] == "ask_user":
                                continue
                            result = self._tool_executor.execute(tc)
                            session.append_tool_message(result, tool_call_id=tc["id"])
                            yield ToolResultEvent(
                                call_id=tc["id"],
                                name=tc["function"]["name"],
                                result=result,
                            )
                        session.pause_for_ask_user(ask_user_tc, round_idx=round_idx)
                        session.append_tool_message("", tool_call_id=ask_user_tc["id"])
                        self._session_store.save(session)
                        ask_user_args = json.loads(ask_user_tc["function"]["arguments"])
                        yield SessionPaused(
                            session_id=session.session_id,
                            call_id=ask_user_tc["id"],
                            questions=ask_user_args.get("questions", []),
                        )
                        return

                    for tc in tool_calls:
                        if tc["function"]["name"] == "ask_user":
                            event = ToolCallEvent(
                                call_id=tc["id"],
                                name=tc["function"]["name"],
                                arguments=tc["function"]["arguments"],
                            )
                            user_answer = yield event
                            ask_user_args = json.loads(tc["function"]["arguments"])
                            questions = ask_user_args.get("questions", [])
                            result = _build_ask_user_result(
                                user_answer or "", questions
                            )
                        else:
                            yield ToolCallEvent(
                                call_id=tc["id"],
                                name=tc["function"]["name"],
                                arguments=tc["function"]["arguments"],
                            )
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

    def continue_stream(
        self, request: ContinueRequest
    ) -> Generator[
        ContentDelta | ToolCallEvent | ToolResultEvent | SessionPaused | StreamComplete,
        None,
        None,
    ]:
        """Resume a paused session with the user's answer."""
        session = self._session_store.get(request.session_id)
        if session is None:
            raise SessionNotFoundError(
                f"Session not found: {request.session_id}",
                display_message="Session not found.",
            )
        if not session.is_paused:
            raise SessionNotPausedError(
                f"Session {request.session_id} is not in a paused state",
                display_message="Session is not in a paused state.",
            )

        tc = session.pending_tool_call
        if tc is None:
            raise RuntimeError("Session is paused but no pending tool call found")
        pending_args = json.loads(tc["function"]["arguments"])
        questions = pending_args.get("questions", [])
        result = _build_ask_user_result(request.answer, questions)
        session.replace_tool_message(result, tool_call_id=tc["id"])
        self._session_store.save(session)
        yield ToolResultEvent(call_id=tc["id"], name="ask_user", result=result)
        resume_round = session.pending_round
        session.resume_with_answer()

        next_ask_user_tc = _find_next_unanswered_ask_user(session)
        if next_ask_user_tc is not None:
            session.pause_for_ask_user(next_ask_user_tc, round_idx=resume_round)
            session.append_tool_message("", tool_call_id=next_ask_user_tc["id"])
            self._session_store.save(session)
            ask_user_args = json.loads(next_ask_user_tc["function"]["arguments"])
            yield SessionPaused(
                session_id=session.session_id,
                call_id=next_ask_user_tc["id"],
                questions=ask_user_args.get("questions", []),
            )
            return

        agent_definition = self._agent_definitions.get(session.agent_id)
        llm_client = self._llm_client_factory(agent_definition)
        tools = self._resolve_tools(agent_definition)
        model = agent_definition.model
        _start_time = time.perf_counter()
        _accumulated_text = ""

        try:
            for round_idx in range(resume_round + 1, agent_definition.max_tool_rounds):
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

                    ask_user_tc = next(
                        (
                            tc
                            for tc in tool_calls
                            if tc["function"]["name"] == "ask_user"
                        ),
                        None,
                    )
                    if ask_user_tc and self._is_api_context:
                        for tc in tool_calls:
                            if tc["function"]["name"] == "ask_user":
                                continue
                            result = self._tool_executor.execute(tc)
                            session.append_tool_message(result, tool_call_id=tc["id"])
                            yield ToolResultEvent(
                                call_id=tc["id"],
                                name=tc["function"]["name"],
                                result=result,
                            )
                        session.pause_for_ask_user(ask_user_tc, round_idx=round_idx)
                        self._session_store.save(session)
                        ask_user_args = json.loads(ask_user_tc["function"]["arguments"])
                        yield SessionPaused(
                            session_id=session.session_id,
                            call_id=ask_user_tc["id"],
                            questions=ask_user_args.get("questions", []),
                        )
                        return

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

    def _build_paused_result(
        self,
        *,
        session: ConversationSession,
        ask_user_tc: ToolCall,
        round_idx: int,
        tool_call_history: list[ToolCallRecord],
    ) -> RunAgentPaused:
        session.pause_for_ask_user(ask_user_tc, round_idx=round_idx)
        ask_user_args = json.loads(ask_user_tc["function"]["arguments"])
        return RunAgentPaused(
            session_id=session.session_id,
            call_id=ask_user_tc["id"],
            questions=ask_user_args.get("questions", []),
            tool_call_history=tool_call_history,
        )

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
                    current_datetime=datetime.now(timezone.utc).isoformat()
                ),
            )

        session = self._session_store.get(session_id)
        if session is None:
            raise SessionNotFoundError(
                f"Session not found: {session_id}",
                display_message="Session not found.",
            )
        return session

    def _resolve_tools(
        self, agent_definition: AgentDefinition
    ) -> list[ToolDefinition] | None:
        if not self._tool_executor or not agent_definition.tools:
            return None
        return self._tool_executor.get_definitions(agent_definition.tools)
