import asyncio

from openai import AsyncOpenAI


async def main() -> None:
    async with AsyncOpenAI() as client:
        response = await client.responses.create(
            model="gpt-4.1-nano",
            input="こんにちは。短く自己紹介して。",
        )

    print(response.output_text)


def cli() -> None:
    asyncio.run(main())


if __name__ == "__main__":
    cli()
