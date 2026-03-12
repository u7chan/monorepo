import asyncio
import sys

from openai import AsyncOpenAI


async def main(user_prompt: str) -> None:
    async with AsyncOpenAI() as client:
        response = await client.responses.create(
            model="gpt-4.1-nano",
            input=user_prompt,
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
