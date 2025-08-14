# Requirements Document

## Introduction

このプロジェクトは、任意のPythonコードを安全に実行するためのシステムを構築します。Nix環境を使用してライブラリの依存関係を隔離し、Dockerコンテナによるセキュリティ層を提供します。最終的にはMCPサーバとして統合可能な形で実装します。

## Requirements

### Requirement 1

**User Story:** 開発者として、任意のrequirements.txtとmain.pyファイルを送信して、隔離された環境で安全にPythonコードを実行したい。

#### Acceptance Criteria

1. WHEN クライアントがrequirements.txtとmain.pyをPOSTリクエストで送信 THEN システムは両ファイルを受け取り一時ディレクトリに保存する
2. WHEN ファイルが保存された THEN システムは隔離されたNix環境でPythonライブラリをインストールする
3. WHEN ライブラリインストールが完了 THEN システムはmain.pyを実行し結果を返す
4. WHEN 実行が完了 THEN システムは標準出力、標準エラー出力、リターンコードを含むレスポンスを返す

### Requirement 2

**User Story:** システム管理者として、実行環境を完全に隔離してホストシステムへの影響を防ぎたい。

#### Acceptance Criteria

1. WHEN Pythonコードが実行される THEN 実行は別のDockerコンテナ内で行われる
2. WHEN コンテナが起動される THEN ホストファイルシステムへの書き込みアクセスは禁止される
3. WHEN コードが実行される THEN 実行時間は10秒でタイムアウトする
4. IF 実行が完了またはタイムアウト THEN コンテナは自動的に削除される

### Requirement 3

**User Story:** 開発者として、再現性の高いPython環境でコードを実行したい。

#### Acceptance Criteria

1. WHEN Python環境が構築される THEN Nixパッケージマネージャーを使用して依存関係を管理する
2. WHEN requirements.txtが処理される THEN uvパッケージマネージャーを使用してライブラリを高速インストールする
3. WHEN 同じrequirements.txtが再度処理される THEN 同一の環境が再現される
4. WHEN 環境構築が失敗 THEN エラー詳細がクライアントに返される

### Requirement 4

**User Story:** API利用者として、FastAPIベースのWebサービス経由でPythonコード実行機能にアクセスしたい。

#### Acceptance Criteria

1. WHEN システムが起動 THEN FastAPIサーバーがHTTPリクエストを受け付ける
2. WHEN /runエンドポイントにPOSTリクエストが送信される THEN requirements.txtとmain.pyファイルがアップロードされる
3. WHEN ファイルアップロードが完了 THEN 実行結果がJSONレスポンスで返される
4. WHEN APIエラーが発生 THEN 適切なHTTPステータスコードとエラーメッセージが返される

### Requirement 5

**User Story:** 将来の拡張として、このシステムをMCPサーバとして統合したい。

#### Acceptance Criteria

1. WHEN システム設計が完了 THEN MCPサーバ仕様への変換が可能なアーキテクチャになっている
2. WHEN コード実行機能が実装される THEN MCPプロトコルでの呼び出しに対応可能な構造になっている
3. WHEN 実行結果が生成される THEN MCPレスポンス形式への変換が容易になっている
4. IF 将来MCPサーバ化が必要 THEN 最小限の変更で対応できる

### Requirement 6

**User Story:** セキュリティ担当者として、悪意のあるコードからシステムを保護したい。

#### Acceptance Criteria

1. WHEN コンテナが実行される THEN root権限なしで動作する
2. WHEN ネットワークアクセスが試行される THEN 外部ネットワークへのアクセスが制限される
3. WHEN システムコールが実行される THEN 危険なシステムコールが制限される
4. WHEN リソース使用量が上限に達する THEN 実行が自動的に停止される

### Requirement 7

**User Story:** 開発者として、コード品質を保つためにフォーマットとリンターを使用したい。

#### Acceptance Criteria

1. WHEN Pythonコードが実行される前 THEN ruffを使用してコードフォーマットが適用される
2. WHEN コードの静的解析が必要 THEN ruffリンターがコード品質をチェックする
3. WHEN フォーマットエラーが検出される THEN エラー詳細がクライアントに返される
4. IF コードが品質基準を満たさない THEN 実行前に警告またはエラーが表示される

### Requirement 8

**User Story:** インフラ担当者として、システムをコンテナ化して配布したい。

#### Acceptance Criteria

1. WHEN システムが構築される THEN 実行用Dockerfileが提供される
2. WHEN 管理用サーバーが構築される THEN FastAPI用Dockerfileが提供される
3. WHEN コンテナがビルドされる THEN 必要な依存関係がすべて含まれる
4. WHEN docker-compose設定が提供される THEN 複数コンテナの連携が可能になる