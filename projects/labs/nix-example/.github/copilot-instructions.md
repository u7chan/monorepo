# GitHub Copilot Instructions

## プロジェクト概要

このプロジェクトは、Nix環境を使用した安全なPythonコード実行システムです。任意のPythonコードを隔離された環境で実行し、セキュリティと再現性を確保します。

## 仕様ファイルの参照

実装時は必ず以下の仕様ファイルを参照してください：

### 必須参照ファイル
- `.kiro/specs/nix-python-executor/requirements.md` - 機能要件と受け入れ基準
- `.kiro/specs/nix-python-executor/design.md` - システム設計とアーキテクチャ
- `.kiro/specs/nix-python-executor/tasks.md` - 実装タスクリスト

## 実装ガイドライン

### 1. タスク実行の原則
- **一度に一つのタスクのみ実行**：tasks.mdのタスクリストから一つずつ順番に実装
- **要件との対応確認**：各タスクの_Requirements_セクションで対応する要件を確認
- **設計仕様の遵守**：design.mdのアーキテクチャとコンポーネント設計に従う

### 2. コード品質基準
- **型ヒント必須**：すべてのPython関数に適切な型ヒントを追加
- **Pydanticモデル使用**：データ構造はPydanticのBaseModelを継承
- **エラーハンドリング**：適切な例外処理とHTTPステータスコード
- **セキュリティ重視**：コンテナ隔離とリソース制限を厳格に実装

### 3. 技術スタック
- **FastAPI**: Web APIフレームワーク
- **Docker**: コンテナ化と隔離実行
- **Nix**: 再現可能な環境構築
- **uv**: 高速Pythonパッケージマネージャー
- **ruff**: コードフォーマットとリンティング

### 4. ディレクトリ構造
```
app/
├── main.py              # FastAPIアプリケーション
├── models.py            # Pydanticデータモデル
├── services/            # ビジネスロジック
├── utils/               # ユーティリティ関数
└── tests/               # テストファイル

docker/
├── manager/             # FastAPI Manager用Dockerfile
└── worker/              # Nix Worker用Dockerfile

docker-compose.yml       # サービス構成
```

### 5. 実装時の注意点

#### セキュリティ要件
- コンテナは非root権限で実行
- ネットワークアクセスを無効化
- 実行時間を10秒でタイムアウト
- メモリ使用量を512MBに制限
- 読み取り専用ファイルシステム

#### エラーハンドリング
- ファイルアップロードエラー → 400 Bad Request
- 環境構築エラー → 422 Unprocessable Entity  
- 実行時エラー → 200 OK（結果として返却）
- システムエラー → 500 Internal Server Error

#### データモデル例
```python
class ExecutionRequest(BaseModel):
    requirements_content: str
    code_content: str
    timeout: Optional[int] = 10
    format_code: Optional[bool] = True

class ExecutionResult(BaseModel):
    stdout: str
    stderr: str
    return_code: int
    execution_time: float
    success: bool
```

### 6. テスト戦略
- **単体テスト**: 各コンポーネントの個別機能
- **統合テスト**: コンテナ実行を含むフルフロー
- **セキュリティテスト**: 悪意のあるコードの安全な実行
- **パフォーマンステスト**: 同時実行とリソース使用量

### 7. 将来のMCP統合準備
- プロトコル変換層を考慮した設計
- MCPツール定義に対応可能な構造
- 拡張性を重視したアーキテクチャ

## 実装手順

1. **現在のタスク確認**: tasks.mdで次に実行すべきタスクを特定
2. **要件確認**: 該当タスクの_Requirements_で対応する機能要件を確認
3. **設計確認**: design.mdで実装すべきコンポーネントとインターフェースを確認
4. **実装**: 仕様に従って最小限かつ完全な実装を作成
5. **テスト**: 実装した機能の動作確認

## コード例とパターン

### FastAPIエンドポイント
```python
@app.post("/run", response_model=ExecutionResult)
async def execute_code(
    requirements: UploadFile = File(...),
    code: UploadFile = File(...)
) -> ExecutionResult:
    # 実装内容
```

### Dockerコンテナ実行
```python
def run_container(temp_dir: str) -> subprocess.CompletedProcess:
    cmd = [
        "docker", "run", "--rm",
        "--user", "1000:1000",
        "--network", "none",
        "--memory", "512m",
        "--cpus", "0.5",
        "--read-only",
        # その他の設定
    ]
```

## 開発ワークフロー

### 実装後の品質チェック

各タスク完了後は以下の手順で品質を確認してください：

#### 1. コードフォーマットとリンティング
```bash
# ruffによるコードフォーマット
ruff format .

# ruffによるリンティング
ruff check .

# 型チェック（mypyがある場合）
mypy app/
```

#### 2. テスト実行
```bash
# 単体テストの実行
pytest app/tests/ -v

# カバレッジ付きテスト実行
pytest app/tests/ --cov=app --cov-report=html

# 特定のテストファイルのみ実行
pytest app/tests/test_models.py -v
```

#### 3. セキュリティチェック
```bash
# Dockerコンテナのセキュリティスキャン
docker scout cves <image_name>

# Python依存関係の脆弱性チェック
pip-audit

# Banditによるセキュリティ静的解析
bandit -r app/
```

#### 4. 統合テスト
```bash
# Docker Composeでの統合テスト
docker-compose up --build
curl -X POST http://localhost:8000/run \
  -F "requirements=@test_requirements.txt" \
  -F "code=@test_main.py"

# コンテナログの確認
docker-compose logs fastapi-manager
```

### 実装チェックリスト

各タスク完了時に以下を確認：

- [ ] **コード品質**
  - [ ] 型ヒントが全関数に追加されている
  - [ ] Pydanticモデルが適切に使用されている
  - [ ] エラーハンドリングが実装されている
  - [ ] ruffフォーマットが適用されている
  - [ ] ruffリンターでエラーがない

- [ ] **テスト**
  - [ ] 単体テストが作成されている
  - [ ] テストが全て通る
  - [ ] カバレッジが適切（80%以上推奨）
  - [ ] エラーケースのテストがある

- [ ] **セキュリティ**
  - [ ] コンテナが非root権限で実行される
  - [ ] ネットワークアクセスが制限されている
  - [ ] リソース制限が設定されている
  - [ ] 入力値の検証が実装されている

- [ ] **ドキュメント**
  - [ ] 関数にdocstringが追加されている
  - [ ] APIエンドポイントにOpenAPI仕様が記述されている
  - [ ] READMEが更新されている（必要に応じて）

### デバッグとトラブルシューティング

#### よくある問題と解決方法

1. **Dockerコンテナが起動しない**
   ```bash
   # ログの確認
   docker logs <container_id>
   
   # イメージの再ビルド
   docker-compose build --no-cache
   ```

2. **Nixパッケージのインストールエラー**
   ```bash
   # Nixキャッシュのクリア
   nix-collect-garbage
   
   # Nixチャンネルの更新
   nix-channel --update
   ```

3. **uvパッケージマネージャーのエラー**
   ```bash
   # uvキャッシュのクリア
   uv cache clean
   
   # 仮想環境の再作成
   uv venv --python 3.11
   ```

4. **テスト失敗時の対処**
   ```bash
   # 詳細なテスト出力
   pytest -vvv --tb=long
   
   # 特定のテストのみ実行
   pytest -k "test_function_name"
   ```

### パフォーマンス監視

実装後は以下でパフォーマンスを監視：

```bash
# メモリ使用量の監視
docker stats

# 実行時間の測定
time curl -X POST http://localhost:8000/run \
  -F "requirements=@requirements.txt" \
  -F "code=@main.py"

# 同時実行テスト
ab -n 100 -c 10 -p post_data.txt -T 'multipart/form-data' \
  http://localhost:8000/run
```

このガイドラインに従って、安全で高品質なPythonコード実行システムを実装してください。
