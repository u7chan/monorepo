# ADR 0005: Codex の資格情報とサインイン（Pi SDK + SiWC を Web UI に置く）

- Status: accepted
- Date: 2026-10-25

## 背景

Codex の利用枠を読むには ChatGPT の OAuth access token と `chatgpt-account-id` が要る。token は refresh token で
更新され、refresh token はローテーションする。ホストの Pi（`~/.pi/agent/auth.json`）や u7agent の agent dir を
共有すると、2 プロセスが同じ refresh token を更新して片方の認証が壊れる。

サインインの手段は、CLI（`codex login`）をホストで実行する、OAuth を自前実装する、Pi SDK の
`ModelRuntime.login`（SiWC）を Web UI から使う、の 3 つ。

## 決定

- 資格情報は Portal 専用の `CREDENTIAL_DIR`（既定 `/app/credentials`）に置く。ホストの Pi や u7agent とは共有しない。
- OAuth の実装は持たず、Pi SDK（`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai`）の `ModelRuntime` を
  資格情報の読み取り・更新・サインインだけに使う。agent session は作らない。
- `ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false })` を 1 つだけ作る。model catalog の
  保存もネットワーク更新もしない。
- access token は `getAuth("openai-codex", { minOAuthValidityMs: 15 分 })` から、`accountId` は
  `readStoredCredential("openai-codex", authPath)` から取る。どちらも応答・DB・ログには出さない。
- device id は `/app/credentials/device-id` に UUID で保存し、`ModelRuntime.login` の `getDeviceId` と
  `agentName: "usage-portal"` に渡す。
- サインインは `ModelRuntime.login("openai-codex", "oauth", interaction)` を BFF のメモリ上の状態機械で包む。
  `select` は選択肢を出し（既定はデバイスコード）、`auth_url` / `device_code` / `progress` だけを受け付ける
  （`info` は無視）。`text` / `secret` は「この画面では扱えない方式」として失敗させる。
- `manual_code` は待機中のときだけ受け付け、`prompt.signal` が abort されたら入力欄を閉じ、以後の送信は 400 にする。
- 進行中の二重開始は 409。中断は冪等。開始から 10 分で自動中断してコールバック待受を解放する。
- サインイン成功時は sampler を 1 回走らせ、その完了を待ってから `succeeded` を公開する。
- SDK が投げる `CredentialSynchronizationError` は、`providerId === "openai-codex"` かつ operation が
  login / logout と一致する場合だけ成功として扱う（`auth.json` への保存は済んでいるため）。
- `CREDENTIAL_DIR` は起動時に 0700、`auth.json` / `device-id` は 0600 に揃える。揃えられなければ起動しない。
- 1455 は publish しない。ブラウザのコールバックはコンテナ内の `127.0.0.1` に閉じるため、スマホはデバイスコード、
  PC は貼り付けで完了できるようにしてある。

採用しない案:

- ホストの `~/.pi/agent/auth.json` を共有する: refresh token の更新が競合し、片方の認証が壊れる。
- OAuth を自前実装する: PKCE、callback server、device code、refresh、ローテーションの保守を抱える。SDK と同じ品質を保つ理由が無い。
- CLI サインインを前提にする: スマホから `codex login` を実行できず、コンテナ内のコールバックもホストから届かない。
- token を `.env` や DB に置く: 期限付きでローテーションする値なので、ファイル 1 つ（0600）に閉じる方が事故が少ない。

## 理由

- SDK を認証の境界として使うと、Portal が持つ秘密は `auth.json` だけになり、`getAuth` が期限前 refresh と
  保存の排他制御を引き受ける。
- 状態機械を BFF のメモリに置くと、認可 URL やコードを DB・ログに残さずに済む（再起動で進行中のサインインは消えるが、
  `auth.json` は残る）。
- デバイスコードを既定にすると、コールバックの届かない環境（スマホ、コンテナ）でも同じ手順で完了できる。

## 影響

- `@earendil-works/pi-*` は u7agent と同じバージョンに固定し、Dependabot の自動更新対象から外す（マイナーでも破壊変更が入る）。
- final image は SDK の分だけ大きくなる。認証の再実装より保守性を優先する。
- Codex の `/backend-api/wham/usage` と SiWC は公開契約ではない。変更されたら adapter と状態機械を直す。
- サインアウトは `auth.json` の資格情報を消すだけで、provider 側の接続は失効させない（解除は ChatGPT の設定から行う）。
