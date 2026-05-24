---
name: license-check
description: >
  Node/Python dependency の OSS ライセンスチェックをこの monorepo でローカル実行する時に使う。
  CI で失敗した license check の再現、policy 変更時の validation、全 target 検証の入口。
---

# OSSライセンスチェック

この skill はローカル実行の導線です。仕様の正は次を参照してください。

- `docs/license-check.md`
- `scripts/license-policy.json`
- `scripts/check_licenses.py`

## 通常の確認

単一 target を確認します。

```bash
./scripts/check-licenses --target projects/portfolio
```

複数 target を確認します。

```bash
./scripts/check-licenses --targets projects/portfolio,projects/edit-vid/frontend
```

CI が生成した target file を使います。

```bash
./scripts/check-licenses --changed-targets-file license_check_targets.txt
```

## policy変更時

policy と unit test を確認します。

```bash
./scripts/check-licenses --validate-policy
python -m unittest discover scripts/tests -p 'test_check_licenses.py'
```

## 仕組み変更時

PR CI では全 target 実スキャンを行いません。checker / policy / action / workflow を変更した場合は、ローカルで全 target を確認します。

```bash
./scripts/check-licenses --validate-policy
python -m unittest discover scripts/tests -p 'test_check_licenses.py'
./scripts/check-licenses --all-targets
```

## 必要なコマンド

- Python 3.11+
- `bun`
- `npm`
- `uv`

`scripts/check_licenses.py` 自体は Python 標準ライブラリのみで動きます。Python target の dependency install では `uv sync --python 3.13` を使います。

## 結果の読み方

- `FAIL LICENSE_DENIED`: 禁止ライセンス
- `FAIL NOT_SUPPORTED`: 未対応 package manager または lockfile 欠落
- `FAIL INSTALL_FAILED`: production dependency の一時インストール失敗
- `WARN LICENSE_REVIEW_REQUIRED`: 要確認ライセンス
- `WARN LICENSE_UNKNOWN`: license metadata 欠落または未知の license
- `WARN EXPRESSION_UNSUPPORTED`: 簡易判定できない表現

`FAIL` が1件でもあれば終了コードは `1` です。`WARN` のみなら終了コードは `0` です。
