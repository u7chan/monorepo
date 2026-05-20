"""Structured JSONL debug logging for agent execution.

Environment variables
---------------------
SIMPLE_AGENT_LOG_ENABLED : str = "true"
    Set to "false" to disable logging.
SIMPLE_AGENT_LOG_FILE : str = "logs/agent-debug.jsonl"
    Path to the JSONL output file.
SIMPLE_AGENT_LOG_LEVEL : str = "INFO"
    Minimum log level (DEBUG, INFO, WARNING, ERROR).
SIMPLE_AGENT_LOG_PAYLOADS : str = "summary"
    Payload storage policy: ``summary``, ``metadata``, or ``full``.
SIMPLE_AGENT_LOG_MAX_FIELD_CHARS : int = 500
    Maximum characters in payload ``preview`` under the "summary" policy.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

__all__ = [
    "bind_log_context",
    "configure_logging",
    "log_event",
    "summarize_payload",
]

# ---------------------------------------------------------------------------
# Module state
# ---------------------------------------------------------------------------

_enabled: bool = True
_payload_policy: str = "summary"
_max_field_chars: int = 500
_initialized: bool = False

# ---------------------------------------------------------------------------
# Logger + handler
# ---------------------------------------------------------------------------

_logger = logging.getLogger("simple_agent_poc.observability")
_logger.propagate = False

# ---------------------------------------------------------------------------
# Context variables (asyncio-safe via contextvars)
# ---------------------------------------------------------------------------

_run_id: contextvars.ContextVar[str] = contextvars.ContextVar("run_id", default="")
_session_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "session_id", default=""
)
_agent_id: contextvars.ContextVar[str] = contextvars.ContextVar("agent_id", default="")
_mode: contextvars.ContextVar[str] = contextvars.ContextVar("mode", default="")


# ---------------------------------------------------------------------------
# Payload summarisation
# ---------------------------------------------------------------------------


def summarize_payload(value: object) -> dict[str, object]:
    """Summarize *value* according to the active payload policy.

    Policies
    --------
    ``summary`` (default)
        Include ``preview``, ``length``, ``sha256``, and ``type``.
    ``metadata``
        Include ``length``, ``sha256``, and ``type`` only (no preview).
    ``full``
        Include the complete value under ``content``.
    """
    if value is None:
        return {"type": "null", "length": 0}

    # -- full ----------------------------------------------------------------
    if _payload_policy == "full":
        if isinstance(value, str):
            return {"type": "str", "length": len(value), "content": value}
        try:
            serialized = json.dumps(value, ensure_ascii=False, default=str)
        except (TypeError, ValueError):  # fmt: skip
            return {"type": type(value).__name__, "length": 0, "content": str(value)}
        length = len(serialized)
        if isinstance(value, (dict, list)):
            return {
                "type": type(value).__name__,
                "length": length,
                "content": json.loads(serialized),
            }
        return {"type": type(value).__name__, "length": length, "content": serialized}

    # -- compute common fields ------------------------------------------------
    if isinstance(value, str):
        raw = value
        type_name = "str"
    elif isinstance(value, (dict, list)):
        raw = json.dumps(value, ensure_ascii=False, default=str)
        type_name = type(value).__name__
    else:
        raw = str(value)
        type_name = type(value).__name__

    digest = hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()
    length = len(raw)

    if _payload_policy == "metadata":
        return {"type": type_name, "length": length, "sha256": digest}

    # -- summary (default) ----------------------------------------------------
    result: dict[str, object] = {
        "type": type_name,
        "length": length,
        "sha256": digest,
        "preview": raw[:_max_field_chars],
    }
    return result


# ---------------------------------------------------------------------------
# JSONL formatter
# ---------------------------------------------------------------------------

# Standard LogRecord attributes that we should *not* leak as event fields.
_LOG_RECORD_ATTRS = frozenset(
    [
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "message",
        "module",
        "msecs",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "thread",
        "threadName",
        "taskName",
    ]
)


class _JSONLFormatter(logging.Formatter):
    """Format a ``LogRecord`` as a single-line JSON object."""

    def format(self, record: logging.LogRecord) -> str:
        obj: dict[str, object] = {
            "timestamp": datetime.fromtimestamp(
                record.created, tz=timezone.utc
            ).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "level": record.levelname,
            "event": record.msg,
            "logger": record.name,
        }

        # Context fields
        obj["run_id"] = _run_id.get() or None
        obj["session_id"] = _session_id.get() or None
        obj["agent_id"] = _agent_id.get() or None
        obj["mode"] = _mode.get() or None

        # Everything else that was passed via ``extra``
        for attr, val in record.__dict__.items():
            if attr in _LOG_RECORD_ATTRS:
                continue
            if val is not None:
                obj[attr] = val

        return json.dumps(obj, ensure_ascii=False, default=str) + "\n"


# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------


def configure_logging() -> None:
    """Read environment variables and enable JSONL debug logging.

    Must be called once during bootstrap (CLI and API).  Subsequent calls
    are no-ops so the function can safely appear in shared bootstrap code.
    """
    global _enabled, _payload_policy, _max_field_chars, _initialized
    if _initialized:
        return
    _initialized = True

    _enabled = os.environ.get("SIMPLE_AGENT_LOG_ENABLED", "true").lower() != "false"
    _payload_policy = os.environ.get("SIMPLE_AGENT_LOG_PAYLOADS", "summary")
    try:
        _max_field_chars = int(
            os.environ.get("SIMPLE_AGENT_LOG_MAX_FIELD_CHARS", "500")
        )
    except ValueError:
        _max_field_chars = 500

    if not _enabled:
        return

    log_file = Path(os.environ.get("SIMPLE_AGENT_LOG_FILE", "logs/agent-debug.jsonl"))
    level_name = os.environ.get("SIMPLE_AGENT_LOG_LEVEL", "INFO").upper()

    log_file.parent.mkdir(parents=True, exist_ok=True)

    handler = logging.FileHandler(str(log_file), encoding="utf-8")
    handler.setFormatter(_JSONLFormatter())
    _logger.addHandler(handler)
    _logger.setLevel(getattr(logging, level_name, logging.INFO))


# ---------------------------------------------------------------------------
# Context binding
# ---------------------------------------------------------------------------


def bind_log_context(
    *,
    run_id: str = "",
    session_id: str = "",
    agent_id: str = "",
    mode: str = "",
) -> None:
    """Bind execution-scoped context fields for the current logical path.

    Uses ``contextvars`` so values propagate into async tasks and threads
    without being passed explicitly through every abstraction layer.
    """
    if run_id:
        _run_id.set(run_id)
    if session_id:
        _session_id.set(session_id)
    if agent_id:
        _agent_id.set(agent_id)
    if mode:
        _mode.set(mode)


# ---------------------------------------------------------------------------
# Event emission
# ---------------------------------------------------------------------------


def log_event(event: str, **fields: object) -> None:
    """Emit a single structured log event.

    Parameters
    ----------
    event : str
        Dot-separated event name (e.g. ``"agent.run.start"``).
    **fields : object
        Arbitrary keyword arguments that will appear as top-level keys in
        the JSON line.  Complex values (``dict``, ``list``, strings) are
        serialised by the JSON formatter.

    Context fields (``run_id``, ``session_id``, ``agent_id``, ``mode``)
    are automatically included from the current ``contextvars`` state.
    """
    if not _enabled:
        return

    extra: dict[str, object] = dict(fields)
    _logger.info(event, extra=extra)
