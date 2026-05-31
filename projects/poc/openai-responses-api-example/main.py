import asyncio
import json
import subprocess
import sys
from collections.abc import Callable
from typing import Any

from openai import AsyncOpenAI
from openai.types.responses.function_tool_param import FunctionToolParam
from openai.types.responses.response_function_tool_call import ResponseFunctionToolCall
from openai.types.responses.response_input_param import ResponseInputParam
from openai.types.responses.response_text_delta_event import ResponseTextDeltaEvent


def get_weather_forecast(location: str) -> dict[str, Any]:
    return {
        "location": location,
        "forecast": "晴れ",
        "temperature_celsius": 23,
        "humidity_percent": 55,
        "note": "この天気予報データはモックです。",
    }


TOOLS: list[FunctionToolParam] = [
    {
        "type": "function",
        "name": "get_weather_forecast",
        "description": "指定した場所の天気予報を取得します。",
        "strict": True,
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
    print(f"[{tool_name}] {arguments}", flush=True)

    handler = TOOL_HANDLERS.get(tool_name)
    if handler is None:
        raise ValueError(f"未対応のツールです: {tool_name}")

    parsed_arguments = json.loads(arguments) if arguments else {}
    result = handler(**parsed_arguments)
    return json.dumps(result, ensure_ascii=False)


async def stream_response(
    client: AsyncOpenAI,
    *,
    model: str,
    input: str | ResponseInputParam,
    tools: list[FunctionToolParam],
    previous_response_id: str | None = None,
) -> tuple[Any, bool]:
    text_streamed = False
    request_kwargs: dict[str, Any] = {
        "model": model,
        "input": input,
        "tools": tools,
    }
    if previous_response_id is not None:
        request_kwargs["previous_response_id"] = previous_response_id

    async with client.responses.stream(**request_kwargs) as stream:
        async for event in stream:
            if isinstance(event, ResponseTextDeltaEvent):
                print(event.delta, end="", flush=True)
                text_streamed = True

        response = await stream.get_final_response()

    return response, text_streamed


async def main(user_prompt: str) -> None:
    async with AsyncOpenAI() as client:
        response, printed_text = await stream_response(
            client,
            model="gpt-4.1-nano",
            input=user_prompt,
            tools=TOOLS,
        )
        printed_any_text = printed_text

        while True:
            function_calls = [
                item
                for item in response.output
                if isinstance(item, ResponseFunctionToolCall)
            ]
            if not function_calls:
                break

            if printed_any_text:
                print(flush=True)
                printed_any_text = False

            tool_outputs: ResponseInputParam = []
            for call in function_calls:
                output = run_tool(call.name, call.arguments)
                tool_outputs.append(
                    {
                        "type": "function_call_output",
                        "call_id": call.call_id,
                        "output": output,
                    }
                )

            response, printed_text = await stream_response(
                client,
                model="gpt-4.1-nano",
                input=tool_outputs,
                tools=TOOLS,
                previous_response_id=response.id,
            )
            printed_any_text = printed_text

        if printed_any_text:
            print(flush=True)


def cli() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("使い方: uv run dev <user_prompt>")

    user_prompt = " ".join(sys.argv[1:]).strip()
    if not user_prompt:
        raise SystemExit("user_prompt を指定してください。")

    asyncio.run(main(user_prompt))


def check() -> None:
    commands = [
        ["ruff", "check", "."],
        ["ty", "check"],
    ]
    for command in commands:
        completed = subprocess.run(command, check=False)
        if completed.returncode != 0:
            raise SystemExit(completed.returncode)


if __name__ == "__main__":
    cli()
