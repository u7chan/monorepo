#!/usr/bin/env bash
# ガードレール点検スクリプト（maimai_dx_rating_calc 用）
# 使い方:
#   bash .agents/skills/guardrail-check/check.sh            # git diff main...HEAD を検査
#   bash .agents/skills/guardrail-check/check.sh --cached   # git diff --cached を検査
#   bash .agents/skills/guardrail-check/check.sh <file>     # 指定 diff ファイルを検査
# 終了コード: 0 = 全てクリーン / 1 = 要確認あり（!! 行を目視確認）
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

DIFF=""
FILTERED=""
TMP=""
case "${1:-}" in
  --cached) TMP="$(mktemp)"; git diff --cached > "$TMP"; DIFF="$TMP" ;;
  "")       TMP="$(mktemp)"; git diff main...HEAD > "$TMP" 2>/dev/null || { echo "git diff main...HEAD に失敗しました"; exit 2; }; DIFF="$TMP" ;;
  *)        DIFF="$1" ;;
esac
NUMCAND="$(mktemp)"
SONGCAND="$(mktemp)"
# 自己参照除外: このスキル自身のファイルは検査パターン定義を含むため、内容 grep の対象から外す
FILTERED="$(mktemp)"
awk '/^[+-]{3} .*\.agents\/skills\/guardrail-check\// {skip=1; next} /^[+-]{3} / {skip=0} !skip' "$DIFF" > "$FILTERED"
if ! cmp -s "$DIFF" "$FILTERED"; then
  echo "（注: 差分に .agents/skills/guardrail-check/ 自身が含まれるため内容チェックから除外します。スキルファイルの内容は目視で確認してください）"
fi
trap 'rm -f "$TMP" "$FILTERED" "$NUMCAND" "$SONGCAND"' EXIT

[ -s "$DIFF" ] || echo "（diff は空です: 検査対象の変更がありません）"
hits=0

check_grep() { # $1=表示名  $2=ERE パターン（対象: $FILTERED）
  local out
  out=$(grep -nE "$2" "$FILTERED" 2>/dev/null)
  if [ -n "$out" ]; then
    echo "  !! ヒット: $1"; echo "$out" | sed 's/^/    /'; hits=$((hits+1))
  else
    echo "  OK: $1"
  fi
}

check_pattern_file() { # $1=表示名  $2=パターンファイル（固定文字列・行単位。対象: $FILTERED）
  local out
  if [ -s "$2" ]; then
    out=$(grep -nFf "$2" "$FILTERED" 2>/dev/null)
    if [ -n "$out" ]; then
      echo "  !! ヒット: $1（候補 $(wc -l < "$2" | tr -d ' ') 件から一致）"; echo "$out" | sed 's/^/    /'; hits=$((hits+1))
    else
      echo "  OK: $1（候補 $(wc -l < "$2" | tr -d ' ') 件と一致なし）"
    fi
  else
    echo "  OK: $1（data/ に候補なし）"
  fi
}

echo "① 機密パターン（API key・秘密鍵・パスワード・個人パス・UUID・issue 番号）"
check_grep "機密パターン" 'api[_-]?key|secret|passwd|BEGIN (RSA|OPENSSH|EC) |sk-[A-Za-z0-9]{16,}|/home/[a-z0-9_]+|\.pi/agent/sessions|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|issue-[0-9]+'

echo ""
echo "② .jsonl / .pyc の混入（git status）"
out=$(git status --short | grep -E '\.jsonl|\.pyc')
if [ -n "$out" ]; then echo "  !! ヒット: $out"; hits=$((hits+1)); else echo "  OK: なし"; fi

echo ""
echo "③ 実データ由来の数値（data/ から抽出: 達成率 4 桁小数・5 桁 RATING 値）"
{
  grep -rhoE '[0-9]+\.[0-9]{4}' data/pastes data/score_dump data/action_plan.md data/analysis_picks.md 2>/dev/null
  grep -rhoE '\b[0-9]{5}\b' data/action_plan.md data/analysis_picks.md 2>/dev/null
} | sort -u > "$NUMCAND"
check_pattern_file "実数値の一致" "$NUMCAND"

echo ""
echo "④ 実曲名（data/action_plan.md・data/analysis_picks.md の表から抽出）"
awk -F'|' 'NF>=4 {
  gsub(/^ +| +$/, "", $3)
  if ($3 ~ /曲|あたり|必要数|結果|増分|残り|現在|系統|難易度|優先|方法|Lv|定数|達成率|追加|%|^---*$|^[+-]?[0-9.,]+$|^(ST|DX) /) next
  if (length($3) >= 2) print $3
}' data/action_plan.md data/analysis_picks.md 2>/dev/null | sort -u > "$SONGCAND"
check_pattern_file "実曲名の一致" "$SONGCAND"

echo ""
echo "⑤ 「§」表記の不使用"
check_grep "§" '§'

echo ""
echo "⑥ 第三者サイトの具体名（@wiki・攻略・データサイト・定数表サイト等）"
check_grep "第三者サイト名" '@wiki|攻略|データサイト|チャートサイト|定数表サイト'

echo ""
echo "⑦ http(s) URL（公式ドメイン以外を検出・目視用一覧）"
out=$(grep -nEo 'https?://[^ )"`]+' "$FILTERED" | sort -u)
if [ -n "$out" ]; then
  echo "$out" | sed 's/^/    /'
  bad=$(echo "$out" | grep -viE 'https?://(maimai\.sega\.jp|info-maimai\.sega\.jp|maimaidx\.jp|otogame-net\.com|www\.sega\.jp|example\.com|localhost)')
  if [ -n "$bad" ]; then echo "  !! 公式ドメイン以外: $bad"; hits=$((hits+1)); else echo "  OK: 公式ドメインのみ"; fi
else
  echo "  OK: URL なし"
fi

echo ""
echo "⑧ 達成率っぽい値の出現（目視用・構造のみでヒット扱いにしない）"
out=$(grep -nE '(100|[0-9]{2})\.[0-9]{4}%?' "$FILTERED")
if [ -n "$out" ]; then echo "$out" | sed 's/^/    /'; else echo "  OK: なし"; fi

echo ""
echo "⑨ diff の整形（git diff --check main...HEAD）"
if git diff --check main...HEAD; then echo "  OK: 空白エラーなし"; else echo "  !! 空白エラーあり"; hits=$((hits+1)); fi

echo ""
echo "⑩ data/ が追跡されていないこと"
out=$(git ls-files | grep -E '^data/')
if [ -n "$out" ]; then echo "  !! 追跡済み: $out"; hits=$((hits+1)); else echo "  OK: 追跡なし"; fi

echo ""
echo "⑪ 未追跡ファイル・作業ツリーの状態"
git status --short | sed 's/^/    /'
[ -z "$(git status --short)" ] && echo "  OK: クリーン"

echo ""
echo "⑫ テスト（python3 -m unittest poc/test_rating.py）"
out=$(python3 -m unittest poc/test_rating.py 2>&1)
if [ $? -eq 0 ]; then echo "  OK: ${out##*Ran }"; else echo "  !! テスト失敗"; echo "$out" | tail -5 | sed 's/^/    /'; hits=$((hits+1)); fi

echo ""
if [ "$hits" -gt 0 ]; then
  echo "結果: 要確認 $hits 件（上記の !! 行を目視確認してください）"
  exit 1
else
  echo "結果: 全てクリーン"
  exit 0
fi