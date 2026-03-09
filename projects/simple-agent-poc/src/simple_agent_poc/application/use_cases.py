"""Application use cases."""

from uuid import uuid4

from simple_agent_poc.application.dto import RunAgentRequest, RunAgentResponse
from simple_agent_poc.application.ports import LLMClient, SessionStore
from simple_agent_poc.core.session import ConversationSession
from simple_agent_poc.core.types import SessionNotFoundError, ValidationError


class RunAgentUseCase:
    """Reusable execution path for session-aware agent interactions."""

    def __init__(
        self,
        *,
        llm_client: LLMClient,
        session_store: SessionStore,
        system_prompt: str,
    ) -> None:
        self._llm_client = llm_client
        self._session_store = session_store
        self._system_prompt = system_prompt

    def execute(self, request: RunAgentRequest) -> RunAgentResponse:
        """Run the agent for a single user message."""
        if not request.message.strip():
            raise ValidationError("message must not be blank")

        session = self._load_session(request.session_id)
        session.append_user_message(request.message)

        response = self._llm_client.complete(list(session.messages))

        session.append_assistant_message(response["content"])
        self._session_store.save(session)
        return RunAgentResponse.from_llm_response(
            response, session_id=session.session_id
        )

    def _load_session(self, session_id: str | None) -> ConversationSession:
        if session_id is None:
            return ConversationSession.start(
                session_id=uuid4().hex,
                system_prompt=self._system_prompt,
            )

        session = self._session_store.get(session_id)
        if session is None:
            raise SessionNotFoundError(
                f"Session not found: {session_id}",
                display_message="Session not found.",
            )
        return session
