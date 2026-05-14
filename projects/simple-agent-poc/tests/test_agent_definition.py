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
