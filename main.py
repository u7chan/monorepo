import asyncio
import json
import sys
from collections.abc import Callable
from typing import Any

from openai import AsyncOpenAI


def get_weather_forecast(location: str) -> dict[str, Any]:
    return {
        "location": location,
        "forecast": "晴れ",
        "temperature_celsius": 23,
        "humidity_percent": 55,
        "note": "この天気予報データはモックです。",
    }


TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "get_weather_forecast",
        "description": "指定した場所の天気予報を取得します。",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "天気予報を知りたい場所",
                }
            },
            "required": ["location"],
            "additionalProperties": False,
        },
    }
]

TOOL_HANDLERS: dict[str, Callable[..., dict[str, Any]]] = {
    "get_weather_forecast": get_weather_forecast,
}


def run_tool(tool_name: str, arguments: str) -> str:
    handler = TOOL_HANDLERS.get(tool_name)
    if handler is None:
        raise ValueError(f"未対応のツールです: {tool_name}")

    parsed_arguments = json.loads(arguments) if arguments else {}
    result = handler(**parsed_arguments)
    return json.dumps(result, ensure_ascii=False)


async def main(user_prompt: str) -> None:
    async with AsyncOpenAI() as client:
        response = await client.responses.create(
            model="gpt-4.1-nano",
            input=user_prompt,
            tools=TOOLS,
        )

        while True:
            function_calls = [
                item for item in response.output if item.type == "function_call"
            ]
            if not function_calls:
                break

            tool_outputs = []
            for call in function_calls:
                output = run_tool(call.name, call.arguments)
                tool_outputs.append(
                    {
                        "type": "function_call_output",
                        "call_id": call.call_id,
                        "output": output,
                    }
                )

            response = await client.responses.create(
                model="gpt-4.1-nano",
                previous_response_id=response.id,
                input=tool_outputs,
                tools=TOOLS,
            )

        print(response.output_text)


def cli() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("使い方: uv run dev <user_prompt>")

    user_prompt = " ".join(sys.argv[1:]).strip()
    if not user_prompt:
        raise SystemExit("user_prompt を指定してください。")

    asyncio.run(main(user_prompt))


if __name__ == "__main__":
    cli()
