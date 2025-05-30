import asyncio

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from mcp_use import MCPAgent, MCPClient


async def main():
    # Load environment variables
    load_dotenv()

    # Create configuration dictionary
    client = MCPClient.from_config_file("./mcp.json")

    # Create LLM
    llm = ChatOpenAI(model="gpt-4.1-nano")

    # Create agent with the client
    agent = MCPAgent(llm=llm, client=client, max_steps=30)

    # Run the query
    result = await agent.run(
        "Base64に変換するMCPツールを利用して。入力: 'あいうえお'",
    )
    print(f"\nResult: {result}")


if __name__ == "__main__":
    asyncio.run(main())
