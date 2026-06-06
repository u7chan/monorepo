import os

import pytest
from fastapi.testclient import TestClient

from src.main import app


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def before_each():
    # 各テストの前に環境変数 APP_VERSION を削除する
    if "APP_VERSION" in os.environ:
        del os.environ["APP_VERSION"]


def test_health_check(client):
    """ヘルスチェックエンドポイントのテスト"""
    os.environ["APP_VERSION"] = "1.0.0"

    response = client.get("/")

    assert response.status_code == 200
    assert response.json() == {
        "status": "OK",
        "version": "1.0.0",
    }


def test_health_check_without_version(client):
    """ヘルスチェックエンドポイントのテスト (バージョン未設定)"""
    response = client.get("/")

    assert response.status_code == 200
    assert response.json() == {
        "status": "OK",
        "version": "",
    }
