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
)
from simple_agent_poc.application.ports import LLMClientFactory, SessionStore
from simple_agent_poc.core.agent_definition import (
    AgentDefinition,
    AgentDefinitionRegistry,
)
from simple_agent_poc.core.session import ConversationSession
from simple_agent_poc.core.types import SessionNotFoundError, ValidationError


class RunAgentUseCase:
    """Reusable execution path for session-aware agent interactions."""

    def __init__(
        self,
        *,
        llm_client_factory: LLMClientFactory,
        session_store: SessionStore,
        agent_definitions: AgentDefinitionRegistry,
    ) -> None:
        self._llm_client_factory = llm_client_factory
        self._session_store = session_store
        self._agent_definitions = agent_definitions

    def execute(self, request: RunAgentRequest) -> RunAgentResponse:
        """Run the agent for a single user message."""
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
        response = llm_client.complete(list(session.messages))

        session.append_assistant_message(response["content"])
        self._session_store.save(session)
        return RunAgentResponse.from_llm_response(
            response, session_id=session.session_id
        )

    def execute_stream(
        self, request: RunAgentRequest
    ) -> Generator[ContentDelta | StreamComplete, None, None]:
        """Run the agent for a single user message with streaming."""
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
        start_time = time.perf_counter()
        accumulated_text = ""
        model = agent_definition.model
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

        try:
            for chunk in llm_client.complete_stream(list(session.messages)):
                delta = chunk.get("content_delta")
                if delta:
                    accumulated_text += delta
                    yield ContentDelta(delta=delta)

            session.append_assistant_message(accumulated_text)
            elapsed = time.perf_counter() - start_time
            yield StreamComplete(
                session_id=session.session_id,
                usage=usage,
                model=model,
                response_time=elapsed,
            )
        except Exception:
            if accumulated_text:
                session.append_assistant_message(
                    f"{accumulated_text}\n\n[stream interrupted]"
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
