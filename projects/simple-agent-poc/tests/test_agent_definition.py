"""Tests for agent definition loading."""

from pathlib import Path

import pytest

from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry
from simple_agent_poc.core.types import ValidationError


def valid_config() -> dict[str, object]:
    return {
        "agents": {
            "default": {
                "model": "gpt-4.1-nano",
                "system_prompt": "Default {current_datetime}",
                "temperature": 0.2,
                "tools": [],
            },
            "researcher": {
                "model": "gpt-4.1-nano",
                "system_prompt": "Research {current_datetime}",
                "temperature": 0.1,
                "tools": [],
            },
        }
    }


class TestAgentDefinitionRegistry:
    """Tests for validated agent definition registries."""

    def test_loads_multiple_agents(self) -> None:
        registry = AgentDefinitionRegistry.from_mapping(valid_config())

        default_agent = registry.get("default")
        researcher = registry.get("researcher")

        assert default_agent.model == "gpt-4.1-nano"
        assert default_agent.temperature == 0.2
        assert (
            default_agent.format_system_prompt(current_datetime="2026-05-14T00:00:00")
            == "Default 2026-05-14T00:00:00"
        )
        assert researcher.system_prompt == "Research {current_datetime}"

    def test_loads_from_yaml_file(self, tmp_path: Path) -> None:
        config_file = tmp_path / "agents.yaml"
        config_file.write_text(
            """
agents:
  default:
    model: gpt-4.1-nano
    system_prompt: Default
    tools: []
""",
            encoding="utf-8",
        )

        registry = AgentDefinitionRegistry.from_yaml_file(config_file)

        assert registry.get("default").model == "gpt-4.1-nano"

    def test_format_system_prompt_preserves_non_runtime_braces(self) -> None:
        registry = AgentDefinitionRegistry.from_mapping(
            {
                "agents": {
                    "default": {
                        "model": "gpt-4.1-nano",
                        "system_prompt": (
                            'Now: {current_datetime}\nJSON example: {"ok": true}'
                        ),
                    }
                }
            }
        )

        formatted = registry.get("default").format_system_prompt(
            current_datetime="2026-05-14T00:00:00"
        )

        assert formatted == 'Now: 2026-05-14T00:00:00\nJSON example: {"ok": true}'

    def test_allows_null_temperature(self) -> None:
        registry = AgentDefinitionRegistry.from_mapping(
            {
                "agents": {
                    "default": {
                        "model": "gpt-5.4-mini",
                        "system_prompt": "Prompt",
                        "temperature": None,
                    }
                }
            }
        )

        assert registry.get("default").temperature is None

    def test_rejects_missing_default_agent(self) -> None:
        with pytest.raises(ValidationError, match="default agent"):
            AgentDefinitionRegistry.from_mapping({"agents": {}})

    def test_rejects_missing_required_field(self) -> None:
        with pytest.raises(ValidationError, match="missing required fields: model"):
            AgentDefinitionRegistry.from_mapping(
                {"agents": {"default": {"system_prompt": "Prompt"}}}
            )

    def test_rejects_unknown_agent_field(self) -> None:
        with pytest.raises(ValidationError, match="unknown fields: unknown"):
            AgentDefinitionRegistry.from_mapping(
                {
                    "agents": {
                        "default": {
                            "model": "gpt-4.1-nano",
                            "system_prompt": "Prompt",
                            "unknown": True,
                        }
                    }
                }
            )

    def test_allows_api_type_completion(self) -> None:
        registry = AgentDefinitionRegistry.from_mapping(
            {
                "agents": {
                    "default": {
                        "model": "gpt-4.1-nano",
                        "system_prompt": "Prompt",
                        "api_type": "completion",
                    }
                }
            }
        )

        assert registry.get("default").api_type == "completion"

    def test_allows_api_type_responses(self) -> None:
        registry = AgentDefinitionRegistry.from_mapping(
            {
                "agents": {
                    "default": {
                        "model": "gpt-5.4-nano",
                        "system_prompt": "Prompt",
                        "api_type": "responses",
                    }
                }
            }
        )

        assert registry.get("default").api_type == "responses"

    def test_rejects_invalid_api_type(self) -> None:
        with pytest.raises(
            ValidationError,
            match="api_type must be one of: completion, responses",
        ):
            AgentDefinitionRegistry.from_mapping(
                {
                    "agents": {
                        "default": {
                            "model": "gpt-4.1-nano",
                            "system_prompt": "Prompt",
                            "api_type": "invalid",
                        }
                    }
                }
            )

    def test_rejects_invalid_types(self) -> None:
        with pytest.raises(ValidationError, match="temperature must be a number"):
            AgentDefinitionRegistry.from_mapping(
                {
                    "agents": {
                        "default": {
                            "model": "gpt-4.1-nano",
                            "system_prompt": "Prompt",
                            "temperature": "warm",
                        }
                    }
                }
            )

    def test_rejects_unknown_agent_id(self) -> None:
        registry = AgentDefinitionRegistry.from_mapping(valid_config())

        with pytest.raises(ValidationError, match="Unknown agent_id: missing"):
            registry.get("missing")
