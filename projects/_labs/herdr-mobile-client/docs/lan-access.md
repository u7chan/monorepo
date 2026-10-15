# LAN からの到達（WSL2 → Windows の portproxy → スマホ）

WSL2 内で動かすこの PoC は、Windows 側の `netsh interface portproxy` とファイアウォール規則を経由してだけ
同一 LAN のスマホから見える。設定は `scripts/lan-access.sh` で行う。

## 到達経路

```
スマホ → http://<Windows の LAN IP>:18081 → (portproxy) → <WSL2 の IP>:18081 → Hono
```

- portproxy は `listenaddress=0.0.0.0` で待ち受ける。到達できる相手はファイアウォール規則の `RemoteAddress`（LAN セグメント）で絞る。
- Windows 側に置くのは portproxy とファイアウォール規則の 2 つだけ。Herdr と Pi を扱うプロセスは WSL2 側に固定する（Herdr のソケットも Pi のセッション JSONL も WSL2 側にあるため）。
- 実行は WSL2 上での直接実行（`pnpm build && PORT=18081 pnpm start`）。`Dockerfile` / CD は持たない。

## ポート

- LAN 公開には `18081` を使う。
- 既存の `3000(dev)` 規則と 3000 の portproxy は**変更しない**。3000 は実機から dev サーバーへ直接つなぐ用途で使用中で、既存規則の `RemoteAddress` は Any（全許可）であるため、同じポートに制限付きの規則を足しても和集合になって制限にならない。このため別ポートと別規則を使う。
- 3000 の規則と 18081 の規則は別名なので、規則名を指定して削除・確認すれば互いに影響しない。

## スクリプト

既定は確認のみ。変更は明示したときだけ行う。

```bash
cd projects/_labs/herdr-mobile-client

# 確認（昇格しない）
./scripts/lan-access.sh

# 追加 / 削除（UAC の承認が必要）
./scripts/lan-access.sh --add
./scripts/lan-access.sh --remove

# Windows の LAN IP を自動検出できないとき
./scripts/lan-access.sh --windows-ip <Windows の LAN IP>
```

- WSL2 の IP は既定ルートのインターフェースから自動検出する。Windows の LAN IP と LAN セグメント（プレフィックス長）は、Windows の既定ルートが使うインターフェース（`--windows-ip` を指定した場合はその IP を持つインターフェース）から得る。
- 実行内容は `netsh interface portproxy` と `New-NetFirewallRule` / `Remove-NetFirewallRule` だけ。
- 追加する規則は次のとおり。

| 項目 | 値 |
| --- | --- |
| 表示名 | `18081(herdr-mobile-client)` |
| Protocol / LocalPort | TCP / 18081 |
| Profile | Any（Wi-Fi が Public のため） |
| RemoteAddress | LAN セグメント（例: `192.0.2.0/24`） |

- 変更は `Start-Process -Verb RunAs` による自己昇格で行う（手動なのは UAC の承認だけ）。昇格したプロセスから `\\wsl.localhost\` の UNC パスは読めないため、リポジトリ内の `.ps1` を読ませるのではなくコマンド文字列を組み立てて渡している。
- 昇格したウィンドウは出力を残さないため、結果は一時ファイル経由で受け取って表示する。UAC が拒否された場合や非対話環境では、失敗を握りつぶさずエラーとして表示する。
- 追加・削除のあとは `netsh interface portproxy show v4tov4` と `Get-NetFirewallAddressFilter` を読み直して検証し、期待どおりでなければ失敗として表示する。

## 初回の手順

1. WSL2 側で起動する。トークンは起動ログに出る（[auth.md](./auth.md) を参照）。

   ```bash
   PORT=18081 pnpm start
   ```

2. 到達設定を追加する。

   ```bash
   ./scripts/lan-access.sh --add
   ```

3. 確認する。`0.0.0.0 18081 → <現在の WSL2 の IP> 18081` と、規則の `remoteaddress` が LAN セグメントになっていること。

   ```bash
   ./scripts/lan-access.sh
   ```

4. スマホ（同一 LAN）で `http://<Windows の LAN IP>:18081/` を開き、起動ログのトークンを入力する。

規則本体にはアドレス条件が現れないため、`RemoteAddress` は filter を見て確認する。

```powershell
Get-NetFirewallRule -DisplayName '18081(herdr-mobile-client)' | Get-NetFirewallAddressFilter
```

## WSL2 を再起動したとき

WSL2 の IP は再起動で変わる。portproxy の宛先が古いままだとスマホから届かない。

1. `./scripts/lan-access.sh` を実行する。宛先が現在の WSL2 の IP と違えば注意が表示される。
2. 注意が出た場合は `./scripts/lan-access.sh --add` を再実行して張り直す（UAC の承認が必要）。
3. サーバーも再起動しているため、`HERDR_CLIENT_TOKEN` を渡していなければトークンは新しい値になっている。スマホ側は「トークンを入力し直す」から新しいトークンを入力する。

LAN セグメントが変わった場合（別のネットワークへ移動した場合など）は `RemoteAddress` も古くなる。この場合も `--add` を再実行する。

## 残存リスク

- **HTTPS を使わない。** トークンは LAN 内を平文で流れる。到達経路を同一 LAN に限ることで緩和しているが、同一 LAN の第三者には傍受できる。将来 LAN 上の Docker サーバー経由でリバースプロキシ（HTTPS）を入れる前提で、クライアントは同一オリジン + `/api` のまま移行できる。
- トークン未設定のときは起動のたびに生成する。再起動のたびにスマホでの再入力が必要（[auth.md](./auth.md)）。
- 認証の失敗回数制限、トークンのローテーション・失効は持たない。
- WSL2 の IP も LAN セグメントも変わりうる。変わったら `--add` で張り直す。
