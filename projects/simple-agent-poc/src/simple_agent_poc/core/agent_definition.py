"""Agent definition loading and validation."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, cast

import yaml

from simple_agent_poc.core.types import ValidationError

_ROOT_FIELDS = frozenset({"agents"})
_AGENT_FIELDS = frozenset({"model", "system_prompt", "temperature", "tools"})
_REQUIRED_AGENT_FIELDS = frozenset({"model", "system_prompt"})


@dataclass(frozen=True, slots=True)
class AgentDefinition:
    """Configuration for one selectable agent."""

    agent_id: str
    model: str
    system_prompt: str
    temperature: float | None = None
    tools: list[dict[str, Any]] = field(default_factory=list)

    def format_system_prompt(self, *, current_datetime: str) -> str:
        """Format the system prompt with runtime context."""
        return self.system_prompt.format(current_datetime=current_datetime)


@dataclass(frozen=True, slots=True)
class AgentDefinitionRegistry:
    """Validated collection of agent definitions."""

    _definitions: Mapping[str, AgentDefinition]

    @classmethod
    def from_yaml_file(cls, path: str | Path) -> "AgentDefinitionRegistry":
        """Load agent definitions from a YAML file."""
        config_path = Path(path)
        try:
            data = yaml.safe_load(config_path.read_text(encoding="utf-8"))
        except OSError as error:
            raise ValidationError(
                f"Failed to read agent definitions: {config_path}"
            ) from error
        except yaml.YAMLError as error:
            raise ValidationError(
                f"Invalid agent definitions YAML: {config_path}"
            ) from error

        return cls.from_mapping(data)

    @classmethod
    def from_mapping(cls, data: object) -> "AgentDefinitionRegistry":
        """Build a registry from a parsed YAML mapping."""
        root = _require_mapping(data, "root")
        _reject_unknown_fields(root, _ROOT_FIELDS, "root")

        agents = _require_mapping(root.get("agents"), "agents")
        if "default" not in agents:
            raise ValidationError("Agent definitions must include a default agent")

        definitions = {
            agent_id: _build_agent_definition(agent_id, raw_definition)
            for agent_id, raw_definition in agents.items()
        }
        return cls(_definitions=definitions)

    def get(self, agent_id: str) -> AgentDefinition:
        """Return an agent definition by id."""
        try:
            return self._definitions[agent_id]
        except KeyError as error:
            raise ValidationError(f"Unknown agent_id: {agent_id}") from error


def _build_agent_definition(
    agent_id: object,
    raw_definition: object,
) -> AgentDefinition:
    if not isinstance(agent_id, str) or not agent_id.strip():
        raise ValidationError("Agent ids must be non-blank strings")

    definition = _require_mapping(raw_definition, f"agents.{agent_id}")
    _reject_unknown_fields(definition, _AGENT_FIELDS, f"agents.{agent_id}")

    missing_fields = _REQUIRED_AGENT_FIELDS - definition.keys()
    if missing_fields:
        missing = ", ".join(sorted(missing_fields))
        raise ValidationError(
            f"agents.{agent_id} is missing required fields: {missing}"
        )

    model = _require_non_blank_string(definition["model"], f"agents.{agent_id}.model")
    system_prompt = _require_non_blank_string(
        definition["system_prompt"],
        f"agents.{agent_id}.system_prompt",
    )
    temperature = _optional_float(
        definition.get("temperature"),
        f"agents.{agent_id}.temperature",
    )
    tools = _optional_tools(definition.get("tools"), f"agents.{agent_id}.tools")

    return AgentDefinition(
        agent_id=agent_id,
        model=model,
        system_prompt=system_prompt,
        temperature=temperature,
        tools=tools,
    )


def _require_mapping(value: object, path: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{path} must be a mapping")
    if not all(isinstance(key, str) for key in value):
        raise ValidationError(f"{path} keys must be strings")
    return cast(Mapping[str, Any], value)


def _reject_unknown_fields(
    data: Mapping[str, Any],
    allowed_fields: frozenset[str],
    path: str,
) -> None:
    unknown_fields = data.keys() - allowed_fields
    if unknown_fields:
        unknown = ", ".join(sorted(unknown_fields))
        raise ValidationError(f"{path} has unknown fields: {unknown}")


def _require_non_blank_string(value: object, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{path} must be a non-blank string")
    return value


def _optional_float(value: object, path: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValidationError(f"{path} must be a number")
    return float(value)


def _optional_tools(value: object, path: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValidationError(f"{path} must be a list")
    if not all(isinstance(item, dict) for item in value):
        raise ValidationError(f"{path} items must be mappings")
    return cast(list[dict[str, Any]], value)
