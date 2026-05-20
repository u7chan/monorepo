"""Application use cases."""

import json
import time
from collections.abc import Generator
from datetime import datetime, timezone
from uuid import uuid4

from simple_agent_poc.observability import (
    bind_log_context,
    log_event,
    summarize_payload,
)

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
    Message,
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


_MAX_QUESTIONS = 4
_ASK_USER_ANSWERED_REMINDER = (
    "The ask_user tool result below contains the user's answers for this turn. "
    "Use the provided tool result to complete the user's request now. "
    "Do not call ask_user again, and do not ask the same question again in natural language."
)


def _validate_questions(questions: list[dict]) -> None:
    if not questions:
        raise ValidationError(
            "questions must not be empty",
            display_message="questions must not be empty",
        )
    if len(questions) > _MAX_QUESTIONS:
        raise ValidationError(
            f"Too many questions: {len(questions)} (max {_MAX_QUESTIONS})",
            display_message=f"Too many questions: {len(questions)} (max {_MAX_QUESTIONS})",
        )


def _build_ask_user_result(answers: dict[str, str], questions: list[dict]) -> str:
    """Build the ask_user tool result as natural language text.

    Each answer is matched to its question by question text key.
    For ``choice`` questions, numeric inputs are mapped to option labels.
    """
    if not questions:
        return "（ユーザーからの回答はありません）"

    lines = ["--- ユーザーからの回答 ---"]
    for q in questions:
        question_text = q.get("question", "")
        raw_answer = answers.get(question_text, "（未回答）")
        q_type = q.get("type", "text")
        options = q.get("options", [])
        multi_select = q.get("multiSelect", False)

        display_answer = raw_answer
        if q_type == "choice" and options:
            if multi_select:
                parts = [p.strip() for p in raw_answer.split(",") if p.strip()]
                if parts and all(p.isdigit() for p in parts):
                    labels = []
                    for p in parts:
                        idx = int(p) - 1
                        if 0 <= idx < len(options):
                            labels.append(options[idx]["label"])
                    if labels:
                        display_answer = ", ".join(labels)
            elif raw_answer.strip().isdigit():
                idx = int(raw_answer.strip()) - 1
                if 0 <= idx < len(options):
                    display_answer = options[idx]["label"]
            lines.append(f"- {question_text} → {display_answer}（選択肢から選択）")
        else:
            lines.append(f"- {question_text} → {display_answer}")
    return "\n".join(lines)


def _tools_without_ask_user(
    tools: list[ToolDefinition] | None,
) -> list[ToolDefinition] | None:
    if not tools:
        return tools
    filtered = [tool for tool in tools if tool["function"]["name"] != "ask_user"]
    return filtered or None


def _ask_user_tool_results(session: "ConversationSession") -> list[str]:
    ask_user_call_ids: set[str] = set()
    for msg in session.messages:
        tool_calls = msg.get("tool_calls", [])
        for tc in tool_calls:
            if tc["function"]["name"] == "ask_user":
                ask_user_call_ids.add(tc["id"])

    return [
        msg["content"]
        for msg in session.messages
        if msg.get("role") == "tool"
        and msg.get("tool_call_id") in ask_user_call_ids
        and msg["content"]
    ]


def _messages_for_llm(
    session: "ConversationSession",
    *,
    ask_user_answered: bool,
) -> list[Message]:
    messages = list(session.messages)
    if ask_user_answered:
        tool_results = "\n\n".join(_ask_user_tool_results(session))
        content = _ASK_USER_ANSWERED_REMINDER
        if tool_results:
            content = f"{content}\n\n{tool_results}"
        messages.append({"role": "user", "content": content})
    return messages


def _replace_all_ask_user_placeholders(
    session: "ConversationSession",
    answers: dict[str, str],
    pending_tc: ToolCall,
) -> list[tuple[str, str]]:
    """Replace all ask_user placeholder tool messages from the same assistant batch.

    When multiple ask_user tool calls are aggregated into one pause, this
    ensures every placeholder gets filled with its corresponding answers.
    Returns a list of ``(call_id, result)`` tuples so callers can emit
    ``ToolResultEvent`` for each replaced message.
    """
    results: list[tuple[str, str]] = []
    for msg in reversed(session.messages):
        maybe_tcs = msg.get("tool_calls")
        if msg["role"] == "assistant" and maybe_tcs:
            tc_ids = {t["id"] for t in maybe_tcs}
            if pending_tc["id"] in tc_ids:
                for atc in maybe_tcs:
                    if atc["function"]["name"] == "ask_user":
                        atc_args = json.loads(atc["function"]["arguments"])
                        atc_questions = atc_args.get("questions", [])
                        atc_result = _build_ask_user_result(answers, atc_questions)
                        session.replace_tool_message(atc_result, tool_call_id=atc["id"])
                        results.append((atc["id"], atc_result))
                break
    if not results:
        raise RuntimeError("pending_tool_call not found in any assistant message")
    return results


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

        run_id = uuid4().hex
        agent_definition = self._agent_definitions.get(request.agent_id)
        mode = "api" if self._is_api_context else "cli"
        bind_log_context(
            run_id=run_id,
            agent_id=agent_definition.agent_id,
            mode=mode,
        )
        session = self._load_session(
            request.session_id,
            agent_definition=agent_definition,
        )
        bind_log_context(session_id=session.session_id)
        if session.agent_id != agent_definition.agent_id:
            raise ValidationError("agent_id cannot be changed for an existing session")
        session.append_user_message(request.message)

        log_event(
            "agent.run.start",
            run_id=run_id,
            model=agent_definition.model,
            api_type=agent_definition.api_type,
            stream=False,
        )

        tool_call_history: list[ToolCallRecord] = []

        try:
            result = self._run_react_loop(
                session=session,
                start_round=0,
                tool_call_history=tool_call_history,
            )
            if isinstance(result, RunAgentResponse):
                log_event(
                    "agent.run.end",
                    run_id=run_id,
                    usage=result.usage if result.usage else None,
                    model=result.model,
                    elapsed_ms=int(result.response_time * 1000),
                )
            return result
        except Exception as exc:
            log_event("agent.run.error", error=summarize_payload(str(exc)))
            raise
        finally:
            self._session_store.save(session)
            log_event("session.saved")

    def continue_sync(
        self, request: ContinueRequest
    ) -> RunAgentResponse | RunAgentPaused:
        """Resume a paused session synchronously with the user's answers."""
        run_id = uuid4().hex

        session = self._session_store.get(request.session_id)
        if session is None:
            log_event("session.not_found", session_id=request.session_id)
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

        bind_log_context(
            run_id=run_id,
            session_id=session.session_id,
            agent_id=session.agent_id,
            mode="api" if self._is_api_context else "cli",
        )
        log_event("ask_user.resume", run_id=run_id, tool_call_id=tc["id"])

        _replace_all_ask_user_placeholders(session, request.answers, tc)
        log_event("ask_user.answered", tool_call_id=tc["id"])

        resume_round = session.pending_round
        session.resume_with_answer()

        agent_definition = self._agent_definitions.get(session.agent_id)
        log_event(
            "agent.run.start",
            run_id=run_id,
            model=agent_definition.model,
            api_type=agent_definition.api_type,
            stream=False,
        )

        tool_call_history: list[ToolCallRecord] = []

        try:
            result = self._run_react_loop(
                session=session,
                start_round=resume_round + 1,
                tool_call_history=tool_call_history,
            )
            if isinstance(result, RunAgentResponse):
                log_event(
                    "agent.run.end",
                    run_id=run_id,
                    usage=result.usage if result.usage else None,
                    model=result.model,
                    elapsed_ms=int(result.response_time * 1000),
                )
            return result
        except Exception as exc:
            log_event("agent.run.error", error=summarize_payload(str(exc)))
            raise
        finally:
            self._session_store.save(session)
            log_event("session.saved")

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
        ask_user_answered = start_round > 0

        for round_idx in range(start_round, agent_definition.max_tool_rounds):
            log_event("react.round.start", round=round_idx)
            round_tools = _tools_without_ask_user(tools) if ask_user_answered else tools
            message_count = len(
                _messages_for_llm(session, ask_user_answered=ask_user_answered)
            )
            response = llm_client.complete(
                _messages_for_llm(session, ask_user_answered=ask_user_answered),
                tools=round_tools,
            )

            tool_calls = response.get("tool_calls")
            if not tool_calls:
                session.append_assistant_message(response["content"])
                log_event(
                    "react.round.end",
                    round=round_idx,
                    usage=response.get("usage"),
                    message_count=message_count,
                    elapsed_ms=int(response["response_time"] * 1000),
                )
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
                log_event(
                    "tool.call.start",
                    tool_call_id=tc["id"],
                    tool_name=tc["function"]["name"],
                    round=round_idx,
                )
                try:
                    result = self._tool_executor.execute(tc)
                except Exception as exc:
                    log_event(
                        "tool.call.error",
                        tool_call_id=tc["id"],
                        tool_name=tc["function"]["name"],
                        round=round_idx,
                        error=summarize_payload(str(exc)),
                    )
                    raise
                log_event(
                    "tool.call.end",
                    tool_call_id=tc["id"],
                    tool_name=tc["function"]["name"],
                    round=round_idx,
                    payload=summarize_payload(result),
                )
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
                all_questions: list[dict] = []
                for tc in ask_user_tcs:
                    ask_user_args = json.loads(tc["function"]["arguments"])
                    all_questions.extend(ask_user_args.get("questions", []))

                _validate_questions(all_questions)

                for tc in ask_user_tcs:
                    session.append_tool_message("", tool_call_id=tc["id"])

                log_event(
                    "ask_user.pause",
                    tool_call_id=ask_user_tcs[0]["id"],
                    round=round_idx,
                )
                return self._build_paused_result(
                    session=session,
                    ask_user_tc=ask_user_tcs[0],
                    round_idx=round_idx,
                    tool_call_history=tool_call_history,
                    aggregated_questions=all_questions,
                )

            log_event(
                "react.round.end",
                round=round_idx,
                usage=response.get("usage"),
                message_count=message_count,
                elapsed_ms=int(response["response_time"] * 1000),
            )

        log_event("react.max_rounds_exceeded")
        raise LLMError(
            "Exceeded maximum tool call rounds",
            display_message="Exceeded maximum tool call rounds.",
        )

    def execute_stream(
        self, request: RunAgentRequest
    ) -> Generator[
        ContentDelta | ToolCallEvent | ToolResultEvent | SessionPaused | StreamComplete,
        dict[str, str] | None,
        None,
    ]:
        """Run the agent for a single user message with streaming ReAct loop.

        When the LLM calls the ask_user tool and is_api_context is False,
        the generator pauses via ``yield ToolCallEvent(...)``. The caller
        must inject the user's answer by calling ``generator.send(answer)``.
        """
        if not request.message.strip():
            raise ValidationError("message must not be blank")

        run_id = uuid4().hex
        agent_definition = self._agent_definitions.get(request.agent_id)
        mode = "api" if self._is_api_context else "cli"
        bind_log_context(
            run_id=run_id,
            agent_id=agent_definition.agent_id,
            mode=mode,
        )
        session = self._load_session(
            request.session_id,
            agent_definition=agent_definition,
        )
        bind_log_context(session_id=session.session_id)
        if session.agent_id != agent_definition.agent_id:
            raise ValidationError("agent_id cannot be changed for an existing session")
        session.append_user_message(request.message)

        log_event(
            "agent.run.start",
            run_id=run_id,
            model=agent_definition.model,
            api_type=agent_definition.api_type,
            stream=True,
        )

        llm_client = self._llm_client_factory(agent_definition)
        tools = self._resolve_tools(agent_definition)
        model = agent_definition.model
        _start_time = time.perf_counter()
        _accumulated_text = ""
        ask_user_answered = False

        try:
            for round_idx in range(agent_definition.max_tool_rounds):
                log_event("react.round.start", round=round_idx)
                _accumulated_text = ""
                accumulated_tool_calls: dict[int, ToolCall] = {}
                usage_from_stream: Usage | None = None
                round_tools = (
                    _tools_without_ask_user(tools) if ask_user_answered else tools
                )
                message_count = len(
                    _messages_for_llm(
                        session,
                        ask_user_answered=ask_user_answered,
                    )
                )

                for chunk in llm_client.complete_stream(
                    _messages_for_llm(
                        session,
                        ask_user_answered=ask_user_answered,
                    ),
                    tools=round_tools,
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
                        ask_user_tcs = [
                            tc
                            for tc in tool_calls
                            if tc["function"]["name"] == "ask_user"
                        ]
                        all_questions: list[dict] = []
                        for tc in ask_user_tcs:
                            ask_user_args = json.loads(tc["function"]["arguments"])
                            all_questions.extend(ask_user_args.get("questions", []))

                        _validate_questions(all_questions)

                        for tc in tool_calls:
                            yield ToolCallEvent(
                                call_id=tc["id"],
                                name=tc["function"]["name"],
                                arguments=tc["function"]["arguments"],
                            )
                        for tc in tool_calls:
                            if tc["function"]["name"] == "ask_user":
                                continue
                            log_event(
                                "tool.call.start",
                                tool_call_id=tc["id"],
                                tool_name=tc["function"]["name"],
                                round=round_idx,
                            )
                            try:
                                result = self._tool_executor.execute(tc)
                            except Exception as exc:
                                log_event(
                                    "tool.call.error",
                                    tool_call_id=tc["id"],
                                    tool_name=tc["function"]["name"],
                                    round=round_idx,
                                    error=summarize_payload(str(exc)),
                                )
                                raise
                            log_event(
                                "tool.call.end",
                                tool_call_id=tc["id"],
                                tool_name=tc["function"]["name"],
                                round=round_idx,
                                payload=summarize_payload(result),
                            )
                            session.append_tool_message(result, tool_call_id=tc["id"])
                            yield ToolResultEvent(
                                call_id=tc["id"],
                                name=tc["function"]["name"],
                                result=result,
                            )
                        log_event(
                            "ask_user.pause",
                            tool_call_id=ask_user_tc["id"],
                            round=round_idx,
                        )
                        session.pause_for_ask_user(ask_user_tc, round_idx=round_idx)
                        for tc in ask_user_tcs:
                            session.append_tool_message("", tool_call_id=tc["id"])
                        self._session_store.save(session)
                        log_event("session.saved")
                        yield SessionPaused(
                            session_id=session.session_id,
                            call_id=ask_user_tc["id"],
                            questions=all_questions,
                        )
                        return

                    for tc in tool_calls:
                        if tc["function"]["name"] == "ask_user":
                            event = ToolCallEvent(
                                call_id=tc["id"],
                                name=tc["function"]["name"],
                                arguments=tc["function"]["arguments"],
                            )
                            user_answers = yield event
                            ask_user_args = json.loads(tc["function"]["arguments"])
                            questions = ask_user_args.get("questions", [])
                            result = _build_ask_user_result(
                                user_answers or {}, questions
                            )
                            ask_user_answered = True
                            log_event(
                                "ask_user.answered",
                                tool_call_id=tc["id"],
                                round=round_idx,
                            )
                        else:
                            log_event(
                                "tool.call.start",
                                tool_call_id=tc["id"],
                                tool_name=tc["function"]["name"],
                                round=round_idx,
                            )
                            yield ToolCallEvent(
                                call_id=tc["id"],
                                name=tc["function"]["name"],
                                arguments=tc["function"]["arguments"],
                            )
                            try:
                                result = self._tool_executor.execute(tc)
                            except Exception as exc:
                                log_event(
                                    "tool.call.error",
                                    tool_call_id=tc["id"],
                                    tool_name=tc["function"]["name"],
                                    round=round_idx,
                                    error=summarize_payload(str(exc)),
                                )
                                raise
                            log_event(
                                "tool.call.end",
                                tool_call_id=tc["id"],
                                tool_name=tc["function"]["name"],
                                round=round_idx,
                                payload=summarize_payload(result),
                            )
                        session.append_tool_message(result, tool_call_id=tc["id"])
                        yield ToolResultEvent(
                            call_id=tc["id"],
                            name=tc["function"]["name"],
                            result=result,
                        )
                    log_event(
                        "react.round.end",
                        round=round_idx,
                        usage=usage_from_stream,
                        message_count=message_count,
                        stream=True,
                    )
                else:
                    session.append_assistant_message(_accumulated_text)
                    elapsed = time.perf_counter() - _start_time
                    log_event(
                        "react.round.end",
                        round=round_idx,
                        usage=usage_from_stream,
                        message_count=message_count,
                        stream=True,
                    )
                    log_event(
                        "agent.run.end",
                        run_id=run_id,
                        usage=usage_from_stream,
                        model=model,
                        elapsed_ms=int(elapsed * 1000),
                    )
                    yield StreamComplete(
                        session_id=session.session_id,
                        usage=usage_from_stream,
                        model=model,
                        response_time=elapsed,
                    )
                    return

            log_event("react.max_rounds_exceeded")
            raise LLMError(
                "Exceeded maximum tool call rounds",
                display_message="Exceeded maximum tool call rounds.",
            )
        except Exception as exc:
            log_event("agent.run.error", error=summarize_payload(str(exc)))
            if _accumulated_text:
                session.append_assistant_message(
                    f"{_accumulated_text}\n\n[stream interrupted]"
                )
            else:
                session.append_assistant_message("[stream interrupted]")
            raise
        finally:
            self._session_store.save(session)
            log_event("session.saved")

    def continue_stream(
        self, request: ContinueRequest
    ) -> Generator[
        ContentDelta | ToolCallEvent | ToolResultEvent | SessionPaused | StreamComplete,
        None,
        None,
    ]:
        """Resume a paused session with the user's answers."""
        run_id = uuid4().hex

        session = self._session_store.get(request.session_id)
        if session is None:
            log_event("session.not_found", session_id=request.session_id)
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

        bind_log_context(
            run_id=run_id,
            session_id=session.session_id,
            agent_id=session.agent_id,
            mode="api" if self._is_api_context else "cli",
        )
        log_event("ask_user.resume", run_id=run_id, tool_call_id=tc["id"])

        results = _replace_all_ask_user_placeholders(session, request.answers, tc)
        log_event("ask_user.answered", tool_call_id=tc["id"])
        self._session_store.save(session)
        log_event("session.saved")
        for call_id, result in results:
            yield ToolResultEvent(call_id=call_id, name="ask_user", result=result)

        resume_round = session.pending_round
        session.resume_with_answer()

        agent_definition = self._agent_definitions.get(session.agent_id)
        log_event(
            "agent.run.start",
            run_id=run_id,
            model=agent_definition.model,
            api_type=agent_definition.api_type,
            stream=True,
        )

        llm_client = self._llm_client_factory(agent_definition)
        tools = self._resolve_tools(agent_definition)
        model = agent_definition.model
        _start_time = time.perf_counter()
        _accumulated_text = ""
        ask_user_answered = True

        try:
            for round_idx in range(resume_round + 1, agent_definition.max_tool_rounds):
                log_event("react.round.start", round=round_idx)
                _accumulated_text = ""
                accumulated_tool_calls: dict[int, ToolCall] = {}
                usage_from_stream: Usage | None = None
                round_tools = (
                    _tools_without_ask_user(tools) if ask_user_answered else tools
                )
                message_count = len(
                    _messages_for_llm(
                        session,
                        ask_user_answered=ask_user_answered,
                    )
                )

                for chunk in llm_client.complete_stream(
                    _messages_for_llm(
                        session,
                        ask_user_answered=ask_user_answered,
                    ),
                    tools=round_tools,
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
                        ask_user_tcs = [
                            tc
                            for tc in tool_calls
                            if tc["function"]["name"] == "ask_user"
                        ]
                        all_questions: list[dict] = []
                        for tc in ask_user_tcs:
                            ask_user_args = json.loads(tc["function"]["arguments"])
                            all_questions.extend(ask_user_args.get("questions", []))

                        _validate_questions(all_questions)

                        for tc in tool_calls:
                            if tc["function"]["name"] == "ask_user":
                                continue
                            log_event(
                                "tool.call.start",
                                tool_call_id=tc["id"],
                                tool_name=tc["function"]["name"],
                                round=round_idx,
                            )
                            try:
                                result = self._tool_executor.execute(tc)
                            except Exception as exc:
                                log_event(
                                    "tool.call.error",
                                    tool_call_id=tc["id"],
                                    tool_name=tc["function"]["name"],
                                    round=round_idx,
                                    error=summarize_payload(str(exc)),
                                )
                                raise
                            log_event(
                                "tool.call.end",
                                tool_call_id=tc["id"],
                                tool_name=tc["function"]["name"],
                                round=round_idx,
                                payload=summarize_payload(result),
                            )
                            session.append_tool_message(result, tool_call_id=tc["id"])
                            yield ToolResultEvent(
                                call_id=tc["id"],
                                name=tc["function"]["name"],
                                result=result,
                            )
                        log_event(
                            "ask_user.pause",
                            tool_call_id=ask_user_tc["id"],
                            round=round_idx,
                        )
                        session.pause_for_ask_user(ask_user_tc, round_idx=round_idx)
                        for tc in ask_user_tcs:
                            session.append_tool_message("", tool_call_id=tc["id"])
                        self._session_store.save(session)
                        log_event("session.saved")
                        yield SessionPaused(
                            session_id=session.session_id,
                            call_id=ask_user_tc["id"],
                            questions=all_questions,
                        )
                        return

                    for tc in tool_calls:
                        log_event(
                            "tool.call.start",
                            tool_call_id=tc["id"],
                            tool_name=tc["function"]["name"],
                            round=round_idx,
                        )
                        try:
                            result = self._tool_executor.execute(tc)
                        except Exception as exc:
                            log_event(
                                "tool.call.error",
                                tool_call_id=tc["id"],
                                tool_name=tc["function"]["name"],
                                round=round_idx,
                                error=summarize_payload(str(exc)),
                            )
                            raise
                        log_event(
                            "tool.call.end",
                            tool_call_id=tc["id"],
                            tool_name=tc["function"]["name"],
                            round=round_idx,
                            payload=summarize_payload(result),
                        )
                        session.append_tool_message(result, tool_call_id=tc["id"])
                        yield ToolResultEvent(
                            call_id=tc["id"],
                            name=tc["function"]["name"],
                            result=result,
                        )
                    log_event(
                        "react.round.end",
                        round=round_idx,
                        usage=usage_from_stream,
                        message_count=message_count,
                        stream=True,
                    )
                else:
                    session.append_assistant_message(_accumulated_text)
                    elapsed = time.perf_counter() - _start_time
                    log_event(
                        "react.round.end",
                        round=round_idx,
                        usage=usage_from_stream,
                        message_count=message_count,
                        stream=True,
                    )
                    log_event(
                        "agent.run.end",
                        run_id=run_id,
                        usage=usage_from_stream,
                        model=model,
                        elapsed_ms=int(elapsed * 1000),
                    )
                    yield StreamComplete(
                        session_id=session.session_id,
                        usage=usage_from_stream,
                        model=model,
                        response_time=elapsed,
                    )
                    return

            log_event("react.max_rounds_exceeded")
            raise LLMError(
                "Exceeded maximum tool call rounds",
                display_message="Exceeded maximum tool call rounds.",
            )
        except Exception as exc:
            log_event("agent.run.error", error=summarize_payload(str(exc)))
            if _accumulated_text:
                session.append_assistant_message(
                    f"{_accumulated_text}\n\n[stream interrupted]"
                )
            else:
                session.append_assistant_message("[stream interrupted]")
            raise
        finally:
            self._session_store.save(session)
            log_event("session.saved")

    def _build_paused_result(
        self,
        *,
        session: ConversationSession,
        ask_user_tc: ToolCall,
        round_idx: int,
        tool_call_history: list[ToolCallRecord],
        aggregated_questions: list[dict] | None = None,
    ) -> RunAgentPaused:
        session.pause_for_ask_user(ask_user_tc, round_idx=round_idx)
        if aggregated_questions is not None:
            questions = aggregated_questions
        else:
            ask_user_args = json.loads(ask_user_tc["function"]["arguments"])
            questions = ask_user_args.get("questions", [])
        return RunAgentPaused(
            session_id=session.session_id,
            call_id=ask_user_tc["id"],
            questions=questions,
            tool_call_history=tool_call_history,
        )

    def _load_session(
        self,
        session_id: str | None,
        *,
        agent_definition: AgentDefinition,
    ) -> ConversationSession:
        if session_id is None:
            new_id = uuid4().hex
            session = ConversationSession.start(
                session_id=new_id,
                agent_id=agent_definition.agent_id,
                system_prompt=agent_definition.format_system_prompt(
                    current_datetime=datetime.now(timezone.utc).isoformat()
                ),
            )
            log_event("session.created", session_id=new_id)
            return session

        session = self._session_store.get(session_id)
        if session is None:
            log_event("session.not_found", session_id=session_id)
            raise SessionNotFoundError(
                f"Session not found: {session_id}",
                display_message="Session not found.",
            )
        log_event("session.loaded", session_id=session_id)
        return session

    def _resolve_tools(
        self, agent_definition: AgentDefinition
    ) -> list[ToolDefinition] | None:
        if not self._tool_executor or not agent_definition.tools:
            return None
        return self._tool_executor.get_definitions(agent_definition.tools)
