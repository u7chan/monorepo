# Agent Skills

このディレクトリには monorepo 専用のカスタムスキルを配置します。

## Available Skills

| Skill | Description |
|-------|-------------|
| [dockerfile-designer](dockerfile-designer/SKILL.md) | Activates when asked to create a Dockerfile or when working on a new project in the monorepo |
| [fastapi](fastapi/SKILL.md) | Referenced when creating a project with FastAPI |
| [license-check](license-check/SKILL.md) | Node/Python dependency の OSS ライセンスチェックをこの monorepo でローカル実行する時に使う |
| [github-dependabot-maintain](github-dependabot-maintain/SKILL.md) | `.github/dependabot.yml` を `projects/` 構成と同期させる |
