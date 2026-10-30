# サンドボックスのスキル API

`.agents/skills` のファイルスキルの発見・編集と、ZIP でのエクスポート / インポートの内部 API。認証と規約、実行系は [sandbox-api.md](sandbox-api.md) を参照する。スキルの設計は [api-catalog.md](api-catalog.md#ファイルスキルagentsskills)。

## `GET /v1/skills`

root 相対のディレクトリ配下のファイルスキル（`SKILL.md`）を JSON で返す。BFF は発見結果を SDK の `skillsOverride` へ渡し、モデルには本文ではなく `path` を渡す（本文は `read` 時点のファイル内容。ファイルスキルの扱いは [persistence.md](persistence.md)）。

```
GET /v1/skills?dir=.agents/skills
```

```json
// response
{
  "skills": [
    {
      "name": "example",
      "description": "例のスキル",
      "path": "/workspace/.agents/skills/example/SKILL.md",
      "disableModelInvocation": false
    }
  ]
}
```

- 走査規則（hidden と `node_modules` のスキップ、`.gitignore` / `.ignore` / `.fdignore`、再帰、frontmatter 検証）は SDK の `loadSkillsFromDir` に委譲する。MVP は `SKILL.md` だけを対象にし、SDK が直下で読む非 `SKILL.md` の `.md` は応答から落とす
- `dir` の検証は `GET /v1/files` と同じ（root 外・symlink 脱出は 400、実在しないディレクトリは 404、ディレクトリ以外は 400）
- SDK は子ディレクトリと `SKILL.md` の symlink を辿るため、**realpath が root 内になるスキルだけ**を返す。root 外へ解決するものと壊れた symlink は落とす。path は realpath に揃え、同じ実体へ解決する重複（symlink 経由・循環リンク）は 1 件に畳む
- **走査は専用スレッド（worker）で実行し、期限（既定 2 秒）で打ち切る**。`loadSkillsFromDir` は同じ実体へ複数の経路で到達する形（自己参照する symlink が 2 本あるなど）で走査回数が指数的に増え、同期実行ではサンドボックス本体を塞ぐため。期限切れは 504（`スキルの走査が期限 …`）で、worker は捨てて次の要求で作り直す。期限の間も他のリクエストは処理される（worker は起動時から使い回し、初回だけ SDK の import 分を待つ）
- `path` は realpath（root 内の絶対パス）で、本文は返さない。`disableModelInvocation` は frontmatter の `disable-model-invocation` をそのまま写す
- 組み込みスキル（skill-creator など）は BFF の同梱物なので、この API は関与しない（仮想パス `<root>/.u7agent/builtin-skills/...` への `read` も BFF が横取りし、サンドボックスへは来ない。[api-catalog.md](api-catalog.md#組み込みスキル)）
- 読み取り専用で、ファイルは変更しない

## 共通スキルの編集（`/v1/skills/file`）

共通スキル（`<PI_SANDBOX_CWD>/.agents/skills`）だけを対象にした GUI の編集 API。パス・版・スキルとしての検証はサンドボックス側で完結し、BFF は要求をそのまま渡して応答の形を検証するだけにする（BFF の API は [api-catalog.md](api-catalog.md#ファイルスキルagentsskills) を正とする）。

- `GET /v1/skills/file?relativePath=` は `name` / `description` / **trim していない** `body` / `relativePath` / `fileVersion` / `mtime` / `editable` と、保存できないときだけ `reason` を返す。`mtime` は SKILL.md の更新時刻（epoch ms）で、画面に出す目安であり保存の照合には使わない（照合は `fileVersion`）。SKILL.md だけの値で付随ファイルの更新は反映せず、git checkout や ZIP インポートでも書き換わるため、編集履歴ではなく目安として扱う。`name` / `description` は SDK の発見結果（`name` が無いときは親ディレクトリ名）。`body` は frontmatter を除いた本文（改行は LF に正規化し、先頭の閉じ行を終わらせた改行は frontmatter の境界なので含めない。本文中の改行と前後の空白はそのまま扱う）。発見できない内容（`.gitignore` で除外、frontmatter が読めない）は `editable: false` と理由を返す
- `POST /v1/skills/file` は `{ name, description, body }` を受け、`<skills>/<name>/SKILL.md` をサーバー側で組み立てる。既存ディレクトリと既存の同名共通スキルは 409（上書きも連番化もしない。組み込みとの同名は既存の優先順位に委ねる）。`PATCH` は `{ relativePath, fileVersion, description, body }` を受け、`name` の変更要求は受け付けない。`DELETE` は body を読まずクエリ（`relativePath` / `treeVersion`）だけで受ける
- **保存は元のテキストの変更箇所だけを差し替える**（`server/src/sandbox/skill-edit.ts`）。frontmatter の境界は SDK と同じ BOM / CRLF / CR 正規化後の先頭 `---` と最初の `\n---` で、`description` の値と本文の source range だけを置き換える。本文の書き出しでは閉じ行の改行を必ず付け直す（読み出しで 1 つ落とした分を戻すので、本文の先頭空行を消して保存しても `---` と本文が癒着しない）。YAML 全体の再生成はしないため、未知キー・コメント・キー順・`name`・`disable-model-invocation`・BOM・未変更部分の改行と空白は元のまま残る。変更が無ければファイルを書き換えず、成功応答は現在の `fileVersion` を返す。安全に差し替えられない frontmatter（YAML が壊れている、ルートがマップでない、`description` に anchor がある、description の値がマップ / シーケンス）は 400 と理由で拒否し、全文の書き換えはしない
- 新規だけは `name` / `description` / 本文の固定順・LF で作り、文字列は YAML の二重引用符スカラーとして安全に表現する。本文の書き出しは保存経路と同じ規則（閉じ行の改行を付ける）を使い、既存ファイルをこの形式へ自動変換しない
- 検証は SDK の `loadSkillsFromDir` を正とする。作成と保存の前に候補を一時ディレクトリで走査し、スキルとして読めることを確認する（新規は warning も拒否、既存の保存は変更前の診断に無い warning だけを拒否する。変更しない `name` や 1024 字超の `description` に由来する warning は本文だけの編集を妨げない）。公開後にも実際の発見一覧で対象パスと内容を確認し、確認できなければ自分の変更（同じ版のとき）だけを元に戻して 500 を返す
- 版は `fileVersion` = 元ファイルの**バイト列の SHA-256**（mtime は使わない）、`treeVersion` = 対象フォルダ全体のダイジェスト（相対パスをソートし、エントリ種別・通常ファイルの内容ハッシュ・symlink のリンク文字列を含める。隠しファイルと付随ファイルを除外せず、参照先は辿らない）。不一致は 409、対象が消えていれば 404 で、強制上書きと自動再送は無い。削除確認の走査は `SANDBOX_MAX_ARCHIVE_ENTRIES` / `SANDBOX_MAX_ARCHIVE_BYTES` で制限し、超過・読み取り不能は変更前に拒否する
- パスは workspace root 内であることに加え、root 相対の形が `<skills>/<name>/SKILL.md` で、最寄りの実在祖先の**実パス**も共通スキル置き場の内側であることを要求する（symlink・`..`・プロジェクト / 組み込み / root 外を拒否）。置き場直下の `SKILL.md` と hidden のディレクトリは専用フォルダを特定できないため扱わず、`SKILL.md` が symlink の削除も拒否する。削除は実パスのフォルダだけを `rm` し、symlink の参照先は辿らない
- **排他の順序は「共通スキル置き場の外側 gate → SDK のファイル隊列（`withFileMutationQueue`）」。** GUI の CRUD、共通の中へ解決する SDK `edit` / `write` の実行全体、共通（またはその祖先）を変更する / 共通へ出入りする既存のファイル変更 API を gate に参加させ、取得後にパスを再確認する。SDK の同じ隊列は外から二重に取得しない。排他は SDK と同様の順番待ちで、専用の待機 timeout を追加しない。観測できる abort は未開始なら変更前に拒否し、開始済みの IO が終わる前に解放しない
- 公開は同じディレクトリの一時ファイルからの `rename` で行う。**任意の bash と外部エディタはこの gate に参加しない**ため、版の再確認で観測した変更は拒否するが、比較と書き込みの間の外部プロセスによる競合まで完全な CAS としては保証しない
- 要求の上限は既存の JSON body の上限（`SANDBOX_MAX_BODY_BYTES`）で、超過は 413。GUI の保存経路は BFF 側の 64 KiB が先に効く

## スキルのエクスポート / インポート

`.agents/skills` 全体を 1 本の ZIP としてエクスポート / インポートする。形式は既存のストリーミング ZIP ライタ（`server/src/sandbox/zip.ts`）に揃え、エントリ名は `.agents/skills` 相対（直下がスキルフォルダ）。manifest / version ファイルは置かず、frontmatter の未知キーも解釈せずバイトのまま運ぶ。BFF の API は [api-catalog.md](api-catalog.md#ファイルスキルagentsskills) を正とする。

### `GET /v1/skills/export`

- 対象は `<PI_SANDBOX_CWD>/.agents/skills` に固定する（`path` の query は受けない）。**利用者の除外設定（`archiveSettings.effectiveNames()`）は使わず**、`.git` だけを全階層・ベース名の完全一致で落とし、symlink はエントリに入れない
- 直下は **`SKILL.md` を直接持つディレクトリ**（`SKILL.md` が通常ファイル）だけを入れ、直下のファイルと `SKILL.md` を持たないディレクトリは入れない。配下は空ディレクトリを含めてそのまま入れる
- 保存名は `skills.zip`。応答は `application/zip` / `Content-Disposition: attachment; filename*=UTF-8''skills.zip` / `Cache-Control: no-store` / `X-Content-Type-Options: nosniff` で、**`Content-Length` を付けない**（ストリーム）
- `.agents/skills` が無いときは 404。あるがスキル 0 件のときは空の ZIP を返し、`/check` は `entries: 0` を返す
- `GET /v1/skills/export/check` はダウンロードの `check` と同じ形（`kind` / `name` / `bytes` / `entries` / `skipped`）を返す。`skipped` には実際に落とした `.git` が入る
- 合計サイズ / エントリ数の上限はダウンロードと同じ値と文言を使い、ヘッダ送出前に 413 で断る。UI が出すのはこの 413 の理由で、除外の指定が無いため確認ダイアログは出さない

### `POST /v1/skills/import`

raw の ZIP 本文を受け、`?dryRun=true` で計画だけを返し（スキルは何も変更しない）、省略時は計画に従って適用する。`dryRun` は `true` の完全一致だけを dry run とし、`replace` は繰り返しで受け、保存名と同じ規則（`isValidEntryName`）で検証して重複を畳む。空値・不正な名前と、解釈できない `dryRun` は 400。

- ZIP の読み取りは自前実装（`server/src/sandbox/zip-read.ts`、中央ディレクトリを起点）。store / deflate だけを扱い、data descriptor（bit 3）の有無はどちらも受け、`unzip` バイナリに依存しない
- ディレクトリエントリは展開後 0 バイト（CRC 0）だけを要求し、圧縮データの有無は問わない（Python の `zipfile` のように空ディレクトリを deflate（`size` 0 / `compressedSize` 2）で書くツールがあるため、圧縮データは展開して空と CRC 0 を確かめる）
- エントリ名は UTF-8 として厳密に読み、bit 11 が無い非 ASCII 名は拒否する。`..` / 絶対パス / `\` / 制御文字 / 空セグメントは名として受け付けない
- **構造不正は全体拒否**（`.agents/skills` に何も書かない）: zip slip、重複エントリ名、symlink / 特殊ファイルのエントリ、暗号化・Zip64・store / deflate 以外の圧縮、パスのいずれかのセグメントが `.git`、hidden の直下フォルダ、`SKILL.md` を持たない直下項目、上限超過、CRC-32 / サイズ（ローカルヘッダ・data descriptor・中央ディレクトリ・展開結果）の不一致、切り詰め
- **スキル個別の不正はそのスキルだけ** invalid（frontmatter が読めない / name 規則違反 / description の欠落・超過 / フォルダ名と `name` の不一致）。判定は SDK の `loadSkillsFromDir` を正とし、staging のスキル配下の診断が 1 件でもあれば invalid にする（新しいスキルの作成と同じ判定）。走査は staging のフォルダ自体に対して行い、`.gitignore` / `.ignore` / `.fdignore` も効かせる
- 上限は既存の `SANDBOX_MAX_UPLOAD_BYTES` / `SANDBOX_MAX_ARCHIVE_BYTES` / `SANDBOX_MAX_ARCHIVE_ENTRIES` を再利用し、import 専用の上限を作らない（受信本文はアップロード、展開後はダウンロードと同じ値）
- 一時データは `.agents/.import-<uuid>/`（受信 ZIP・staging・退避）に置き、rename を同じファイルシステムに閉じる。`.agents` が無ければ作る（一時データを置くための副作用で、plan でも起こる）。一時ディレクトリは成功・失敗・中断（`AbortSignal`）のいずれでも消す
- 適用は**共通スキル置き場の gate の内側**で行う。置換対象の解決は既存の共通スキルの規則に揃え（realpath で `.agents/skills` の内側、`SKILL.md` が symlink のスキルは置換しない）、「staging で全件検証 → 置換対象を退避へ rename → 新フォルダを rename → 全件成功後に退避削除」の順に適用する。途中で失敗したら適用済みの分を逆順で戻す。書き込みは受信バイトのまま（`skill-edit.ts` を通さない）
- `replace` に無い conflict は取り込まず、`identical` は書き込みを省略し、`invalid` は常にスキップする。bundle に無い名前・既存に無い名前は無視する（何も作らず、何も消さない）。既存スキルの暗黙の削除・連番併存・部分マージはしない
- 応答は plan と apply で形が違う。plan は `{ skills: [{ name, status, reason? }], entries, bytes }`（`status` は `new` / `identical` / `conflict` / `invalid` で、`reason` は `invalid` のときだけ）。apply は `{ applied: [{ name, relativePath, fileVersion, replaced }], skipped: [{ name, reason }], entries, bytes }` で、`fileVersion` は取り込んだ `SKILL.md` のバイト列の SHA-256。`entries` / `bytes` は検証に使った ZIP の総エントリ数と展開後の総バイト数
- **任意の bash / 外部エディタは gate に参加しない**ため、適用中に外部プロセスが `.agents/skills` を触れば検出できない（既存の保存と同じ線引き）。プロセスが適用中に落ちると `.agents/.import-<uuid>/` が残り得る（隠しディレクトリなので SDK の走査対象外）
- BFF はこの応答を検証してそのまま返す。plan / apply とも一覧（`GET /api/skills/files`）は呼ばず、UI が結果の後に取り直す
