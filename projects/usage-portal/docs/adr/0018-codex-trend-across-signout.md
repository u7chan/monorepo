# ADR 0018: Codex の推移をサインアウト後も同じアカウントで引き継ぐ

- Status: accepted
- Date: 2026-11-01
- 一部置き換え: [ADR 0005](0005-codex-credentials-and-sign-in.md) の「accountId ... どちらも応答・DB・ログには出さない」と [ADR 0007](0007-opencode-multiple-accounts.md) の「Codex のサインアウトも同じ関数を通るので、Codex の sample も消える」

## 背景

Codex のサインアウトは snapshot と error だけでなく sample も消していた（ADR 0007）。
そのため再サインインすると推移は「履歴を収集中です」から始まり、30 日保持している意味が
サインアウトのたびに失われる。資格情報を入れ直すのは同じ ChatGPT アカウントであることが多い。

一方で source id は `codex` の 1 本しかなく、別のアカウントの sample と同じキーに混ざる。
sample を消さずに残すだけでは、アカウントを切り替えたときに前のアカウントの推移を出すことになる。

## 決定

- Codex の source id を ChatGPT の `accountId` で分ける（`codex:<account id>`）。
  未接続時だけ `codex` を使い、そこには `not_connected` / `reauth_required` の error だけを書く。
- `accountId` は `auth.json` から読む（`CodexAuth.accountId()`）。応答・snapshot・ログへは出さない。
- サインアウトは snapshot と error だけを消し、sample は残す（`deleteProviderState`）。
  OpenCode Go のアカウント削除は従来どおり sample も消す（`deleteProviderUsage`）。
- 起動時にサインイン済みなら、旧キー `codex` の snapshot と sample を現在のアカウントのキーへ移す。
  error は移さない。base キーの error はサインアウト中の未接続を表し、サインイン中のアカウントには
  当てはまらないため。移し先に同じ行があれば移さない。旧キーの行は移したあとに消す。
- `/api/usage` の `sources[].id` は `codex` のまま。アカウント別の source id は DB のキーにだけ使う。
- 推移は snapshot があるときだけ返すため、サインアウト中はグラフを出さない。同じアカウントで戻ると、
  残っていた sample がそのまま推移になる。

採用しない案:

- sample を消さずに `codex` のまま残す: アカウントを切り替えたときに履歴が混ざる。
- サインアウト時に sample を別テーブルへ退避する: 読み書きの経路が増えるだけで、source id を分けるのと同じ。
- アカウント変更時だけ古い sample を消す: 前回の account id を資格情報の外に持つ場所が要る。
- sample をアカウント間で共有する: 利用枠はアカウントごとに独立しており、推移の比較にも使えない。

## 理由

source id はもともと「1 つの利用枠の取得元」を表す。Codex の取得元は ChatGPT のアカウントなので、
OpenCode Go の `opencode-go:<uuid>` と同じく `accountId` を含めるのが自然で、テーブル定義を変えずに済む。

サインアウトで snapshot を消すのは、前回の利用枠を接続していない間に出さないため。
sample まで消す理由は無く、同じアカウントで戻ったときに推移が続く方が、次に何が起きるかを読みやすい。

base キーの error を移すと、サインアウト→再サインイン→再起動のたびに `not_connected` が復活し、
サインイン済みなのに未接続の表示になる。起動直後の取得で正しい状態に置き換わるため、error は引き継がない。

## 影響

- DB の `provider` 列に入る Codex のキーが変わる。スキーマと `user_version` は v1 のまま。
- サインアウトしても sample は保持期間（30 日）まで残る。別アカウントの sample は読み手が居なくなり、
  `pruneSamples` の期限で消える。
- accountId はローカルの SQLite の `provider` 列（履歴のキー）にだけ入る。ADR 0005 の「DB に出さない」は
  この用途に限って置き換える。`/api/usage` の `id`・snapshot・ログには出さない。
- 起動時にサインアウトしていると、旧キー `codex` の sample は引き継がない。旧コードはサインアウトで
  sample を消していたため、この状態で残っている sample は無い。
