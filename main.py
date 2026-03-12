import asyncio

from openai import AsyncOpenAI


async def main() -> None:
    async with AsyncOpenAI() as client:
        response = await client.responses.create(
            model="gpt-4.1-nano",
            input="こんにちは。短く自己紹介して。",
        )

    print(response.output_text)


if __name__ == "__main__":
    asyncio.run(main())
