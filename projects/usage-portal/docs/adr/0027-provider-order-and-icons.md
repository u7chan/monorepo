# ADR 0027: カードは Codex → Claude → OpenCode Go の順に並べ、見出しに provider のロゴを置く

- Status: accepted（ロゴの取り込み元は [0030](0030-provider-marks-from-hwc.md) で一部置き換え）
- Date: 2026-11-19
- 関連: [ADR 0016](0016-exhausted-cards-last.md) の使い切ったカードの移動、[ADR 0021](0021-opencode-monthly-order.md) の OpenCode Go の月次順

## 背景

Claude のカードが加わり、応答の並びは Codex → OpenCode Go アカウント → Claude になっている。OpenCode Go の
アカウントを増やすほど Claude は下へ押し出される。Claude はサインインしていないとカードが出ないため、
出たり消えたりする位置が末尾だと見失う。

見出しは名前と小さな補足だけで、狭い画面（簡易表示）では補足を隠す。OpenCode Go のアカウント名は自由入力なので、
カードを並べたときに provider が分からない。Claude と Codex は名前が provider 名そのものだが、同じ見た目の
見出しが続くと、どのカードがどの契約かは補足を読むまで分からない。

## 決定

- `/api/usage` の `sources[]` と、応答前の骨格の並びを Codex → Claude → 登録順のアカウントにする。
  ヘッダーの provider 一覧も同じ順にする。
- 見出しの左に provider のロゴを置く。Codex は OpenAI、Claude は Anthropic、OpenCode Go は opencode のマーク。
  名前が同じ行に出るので装飾（`aria-hidden`）とし、読み上げには足さない。
- ロゴは 1 色（`currentColor`）で、明暗テーマとも同じ形を使う。
- アイコンのパスは `@lobehub/icons-static-svg`（MIT）から取り込み、帰属表示を `THIRD_PARTY_NOTICES.txt` に置いて
  Docker image にも含める。
- 使い切ったカードを末尾へ回す規則（ADR 0016）と、OpenCode Go を月次の残り順に並べる規則（ADR 0021）は変えない。
  変えるのは、並べ替える前の「元の並び」だけ。

採用しない案:

- クライアントだけで並べ替える: 応答前の骨格と応答後で順が変わり、カードが入れ替わる。
- OpenCode Go にだけアイコンを付ける: アカウントの絵文字アイコンと provider の識別が混ざり、provider ごとの見た目が揃わない。
- 補足の文字だけで provider を示す: 簡易表示では補足を隠すため、名前だけのカードが残る。
- ロゴをブランド色にする: ダークモードでコントラストが落ちる色があり、状態ラベルの色と競合する。

## 理由

毎日見る順は、契約している Codex と Claude が先、アカウントを足して増える OpenCode Go が後になる。Claude を
Codex の隣に固定すると、カードが出ていないあいだも位置が動かず、再サインイン後に同じ場所で見つけられる。
ロゴは名前を読まなくても provider を思い出せるようにするためのもので、状態（色と記号）とは別の軸に置く。

## 影響

- `src/server/usage.ts` の `collectSources`、`src/client/App.tsx` の `placeholderSources` とヘッダーの文言。
- `src/client/components/ProviderCard.tsx` の見出し、`src/client/components/ProviderIcon.tsx`、`src/client/lib/provider-icon.ts`、`src/client/styles.css`。
- `THIRD_PARTY_NOTICES.txt` を Docker の final stage に含める。
- `test/usage-api.test.ts` と `test/opencode-api.test.ts` の並びの期待値。
