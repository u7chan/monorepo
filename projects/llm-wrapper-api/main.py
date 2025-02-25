import os

from fastapi import FastAPI

app = FastAPI()


@app.get("/")
async def health_check():
    return {
        "status": "OK",
        "version": os.getenv("APP_VERSION", ""),
    }
