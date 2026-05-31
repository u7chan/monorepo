# OSSライセンスチェック

このリポジトリでは、Node と Python の production dependency を対象に OSS ライセンスを確認します。

初期版は PR CI のログに結果を出します。GitHub Actions artifact は保存しません。

## 対象

license check の対象は、Docker project root ではなく manifest root 単位です。

例:

- `projects/edit-vid`
- `projects/edit-vid/frontend`

PR CI では次の依存定義ファイルが変わった target だけを実スキャンします。

- `package.json`
- `bun.lock`
- `bun.lockb`
- `package-lock.json`
- `pyproject.toml`
- `uv.lock`

README、docs、アプリコードだけの変更では実スキャンしません。

## 必要なランタイム

ローカル実行と GitHub Actions runner には次が必要です。

- Python 3.11+
- `bun`
- `npm`
- `uv`

`scripts/check_licenses.py` 自体は Python 標準ライブラリのみで動きます。dependency metadata の収集では package manager を外部コマンドとして実行します。Python target の dependency install では、`.python-version` があればそのバージョンを使い、なければ `pyproject.toml` の `requires-python` を見て `uv sync --python <version>` の interpreter を選びます。

PR CI では `oven-sh/setup-bun@v2` と `astral-sh/setup-uv@v6` で `bun` / `uv` を用意します。

## 対応しているpackage manager

対応:

| Ecosystem | Lockfile | Install command |
|---|---|---|
| Node | `bun.lock`, `bun.lockb` | `bun install --frozen-lockfile --production --ignore-scripts` |
| Node | `package-lock.json` | `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` |
| Python | `uv.lock` | `uv sync --frozen --no-dev --no-install-project --no-install-workspace --python <requires-pythonに基づくversion>` |

未対応:

- Yarn / pnpm
- Node lockfile なし
- `requirements.txt`
- Poetry
- Pipenv
- `uv.lock` なしの Python project

未対応ケースは `NOT_SUPPORTED` として失敗します。

## ローカル実行

単一 target:

```bash
./scripts/check-licenses --target projects/portfolio
```

複数 target:

```bash
./scripts/check-licenses --targets projects/portfolio,projects/edit-vid/frontend
```

CI と同じ target file:

```bash
./scripts/check-licenses --changed-targets-file license_check_targets.txt
```

policy validation:

```bash
./scripts/check-licenses --validate-policy
```

仕組み変更時の全 target 検証:

```bash
./scripts/check-licenses --validate-policy
python -m unittest discover scripts/tests -p 'test_check_licenses.py'
./scripts/check-licenses --all-targets
```

`--all-targets` はローカル検証用です。PR CI では全 target 実スキャンを行いません。

## 判定ルール

policy は `scripts/license-policy.json` に定義します。

初期ルール:

- `denied`: `AGPL-*`, `GPL-*`, `SSPL-*`, `Commons Clause`
- `review`: `LGPL-*`, `MPL-*`, `EPL-*`, `CDDL-*`
- `allowed`: `MIT`, `Apache-2.0`, `BSD-*`, `ISC`, `0BSD`, `Unlicense`, `Python-2.0`, `BlueOak-*`

例外は `overrides` に追加します。`reason` と `reviewed_at` は必須です。

```json
{
  "ecosystem": "npm",
  "name": "some-package",
  "version": "1.2.3",
  "status": "allowed",
  "license": "MIT",
  "reason": "Reviewed manually on 2026-05-24",
  "reviewed_at": "2026-05-24"
}
```

## SPDX expression

初期版では厳密な SPDX parser は使いません。標準ライブラリだけで簡易判定します。

- `OR`: どれか1つが allowed なら `PASS`
- `AND`: すべて allowed なら `PASS`
- `AND` に review が含まれる場合は `WARN`
- `AND` に denied が含まれる場合は `FAIL`
- unknown / 複雑表現 / 判定不能は `WARN`

## status と reason_code

ログに絵文字は使いません。固定の英字コードを出します。

失敗:

- `LICENSE_DENIED`
- `NOT_SUPPORTED`
- `INSTALL_FAILED`

警告:

- `LICENSE_REVIEW_REQUIRED`
- `LICENSE_UNKNOWN`
- `EXPRESSION_UNSUPPORTED`

`FAIL` が1件でもあれば CI は失敗します。`WARN` のみなら CI は成功します。

## CIでの動き

PR CI では Docker build より前に license check を実行します。

1. 変更ディレクトリを検出する
2. dependency manifest / lockfile の変更から license target を検出する
3. checker / policy / action / workflow 変更時は軽量 validation/test を実行する
4. license target がある場合だけ実スキャンする
5. Docker `test` stage build を実行する

checker / policy / action / workflow が変わった場合でも、PR CI では全 target 実スキャンを行いません。全 target 実スキャンはローカルで `--all-targets` を使って確認します。
