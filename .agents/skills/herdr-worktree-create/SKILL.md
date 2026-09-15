---
name: herdr-worktree-create
description: >
  ユーザーが「<プロジェクト> 起点で Herdr ワークツリーを作って」と依頼した時に使う。
  指定されたプロジェクトを起点に、base 既定 `main` で Herdr のワークツリー workspace を作成し、
  ルートペインの cwd を起点プロジェクト配下に移動して、workspace ID / pane ID / checkout path /
  branch / base commit を報告する。Requires HERDR_ENV=1.
---

# Herdr ワークツリー作成（プロジェクト起点）

指定したプロジェクトを起点に、この monorepo の Git ワークツリーと、それを開いた Herdr ワークスペースを1つ作る。
ワークツリーはリポジトリ単位なので、「起点プロジェクト」は作成元 checkout の pin、branch / label の既定値、
ルートペインの初期 cwd に効く。

## 前提

```bash
test "${HERDR_ENV:-}" = 1 || exit 1
command -v herdr >/dev/null || exit 1
```

Herdr 管理下のペインでなければ何も作らず、その旨を報告して止まる。
`herdr worktree create` はユーザーが明示的に依頼した時だけ実行する。

## 既定値

| 項目 | 既定 | 例 |
|---|---|---|
| 起点プロジェクト | カレントディレクトリ | `projects/portal` |
| base ref | ローカルの `main`（`origin/main` より遅れていれば `origin/main`） | `main` / `origin/main` |
| branch | `feat/<project>-dev` | `feat/portal-dev` |
| label | `<project>` | `portal` |
| ルートペインの cwd | 起点プロジェクト配下 | `<checkout>/projects/portal` |
| focus | 奪わない（`--no-focus`） | ユーザーが `--focus` を明示した時だけ |

- `<project>` は起点プロジェクトのディレクトリ名（`projects/portal` → `portal`）。
- branch 名は AGENTS.md の規則（小文字 kebab-case、プレフィックス付き）に合わせる。ユーザーが作業内容を伝えている場合は `<type>/<project>-<topic>` を提案して確認する。
- branch 指定が無ければ既定を使い、**必ず報告に書く**（後から改名できるため）。

## 手順

### 1. 起点と base を確認する

```bash
git -C "<起点>" rev-parse --show-toplevel
git -C "<起点>" fetch origin
git -C "<起点>" rev-parse --short "<base>"          # 例: main
git -C "<起点>" rev-parse --short "origin/<base>"   # 例: origin/main
```

- `<base>` の既定は `main`。ユーザー指定があればその ref を使う。
- `--short` は 1 つの ref しか受け付けない。`git rev-parse --short main origin/main` は `fatal: Needed a single revision`（終了コード 128）で失敗するので、ref ごとに分けて解決する。
- 起点が Git ワークツリーの外なら止まって報告する。
- 作成に使う base を `base_ref` として確定する（作成コマンドにはこれを渡し、`main` をハードコードしない）。

```bash
base="main"                                             # ユーザー指定があればその ref
local_base=$(git -C "<起点>" rev-parse --short "$base")
remote_base=$(git -C "<起点>" rev-parse --short "origin/$base")
base_ref="$base"
if [ "$local_base" != "$remote_base" ]; then
  if git -C "<起点>" merge-base --is-ancestor "$base" "origin/$base"; then
    base_ref="origin/$base"                             # ローカルの base が古い → 最新の origin 側から切る
  else
    echo "ローカルの $base が origin/$base と分岐しています。base をユーザーに確認する" >&2
  fi
fi
```

- ローカルの base が ahead / diverged の場合は、勝手に決めず base をユーザーに確認してから作成する。
- 既存のワークツリーと branch の衝突を確認する。

```bash
herdr worktree list --cwd "<起点>"
git -C "<起点>" branch --list "<branch>"
```

### 2. 作成する

`--cwd` でソース checkout を pin する。pin しないと呼び出し元ではなくクライアントの focused workspace に従い、別リポジトリを切ってしまう。`--base` には前段で確定した `base_ref` を渡す。

```bash
herdr worktree create \
  --cwd "<起点>" \
  --branch "<branch>" \
  --base "$base_ref" \
  --label "<label>" \
  --no-focus
```

### 3. レスポンスから ID を読む（推測しない）

| JSON パス | 値 |
|---|---|
| `result.workspace.workspace_id` | 作成された workspace ID |
| `result.root_pane.pane_id` | ルートペイン ID（対話シェル） |
| `result.worktree.path` | チェックアウト先 |
| `result.worktree.branch` | branch 名 |

### 4. ルートペインを起点プロジェクト配下に移動する

`herdr worktree create` のルートペインはワークツリー直下（リポジトリ root）で開く。Herdr に初期 cwd を指定するオプションは無いので、作成直後の対話シェルに `cd` を送って起点プロジェクト配下へ移動する。

```bash
prefix=$(git -C "<起点>" rev-parse --show-prefix)   # 例: projects/portal/
if [ -n "$prefix" ]; then
  herdr pane get "<root_pane_id>"                   # agent が居ない = 対話シェルであることを確認
  herdr pane run "<root_pane_id>" "cd $prefix"
  herdr pane get "<root_pane_id>"                   # cwd が <checkout>/<prefix> になる
fi
```

- 起点がリポジトリ root（`prefix` が空）なら何もしない。
- `pane get` の `cwd` が変わらない場合は、シェルの準備前に送られた可能性がある。少し待って1回だけ再送し、それでも変わらなければ報告に「手動で `cd <prefix>` が必要」と書く。
- これはルートペインの初期位置を決めるセットアップであり、委譲ではない（cross-workspace のエージェント起動は下記のとおり禁止のまま）。

### 5. 検証する

```bash
git -C "<checkout path>" branch --show-current
git -C "<checkout path>" log --oneline -1       # 確定した base_ref の commit か
git -C "<checkout path>" status --porcelain   # 空なら clean
herdr pane get "<root_pane_id>"               # cwd が起点プロジェクト配下か
```

### 6. 報告する

- workspace ID（label）とルートペイン ID
- 起点プロジェクト、branch、base ref（`main` / `origin/main`）と base commit（短 SHA）
- チェックアウト先の絶対パスと clean かどうか
- ルートペインの cwd（起点プロジェクト配下になっているか）
- branch 名に既定値を使った場合はその旨

## 注意

- エージェントやコマンドが動いているペインに `cd` を送らない。送るのは作成直後の、`herdr pane get` で `agent` が空の対話シェルだけ。
- ワークツリーは別 workspace。cross-workspace の `herdr agent start` / `herdr agent prompt` は禁止なので、そこにエージェントを立てる起動コマンドはユーザーに渡す（`herdr` skill の Worktree workspaces を参照）。
- 削除（`herdr worktree remove --workspace <workspace_id>`）はユーザーが明示的に求めた時だけ行う。
