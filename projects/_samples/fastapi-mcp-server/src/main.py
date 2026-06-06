from fastapi import FastAPI
from fastapi_mcp import FastApiMCP

app = FastAPI()


@app.get("/")
async def root():
    return {"message": "Hello Fast MCP World"}


mcp = FastApiMCP(
    app,
    name="test",
    description="test mcp server",
)

# Mount the MCP server directly to your FastAPI app
mcp.mount()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
