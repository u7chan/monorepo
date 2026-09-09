# Get License Check Targets

`projects/` 配下の dependency manifest / lockfile 変更から、OSS license check の対象 target を抽出します。

対象ファイル:

- `package.json`
- `bun.lock`
- `bun.lockb`
- `package-lock.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `pyproject.toml`
- `uv.lock`

出力:

- `license_check_targets.txt`
- `LICENSE_CHECK_TARGETS`
- `LICENSE_CHECK_VALIDATION_REQUIRED`
- `LICENSE_CHECK_PNPM_REQUIRED`

pnpm workspace の子packageは、共有lockfileのimportersに登録されていれば親にまとめます。判定は `scripts/check_licenses.py` と共有し、独立lockfileのある子は統合しません。
