"""maimai でらっくすNET のコピペテキストをパースする（PoC）。

入力は maimai でらっくすNET「レコード → 楽曲スコア → LEVEL」の一覧画面を
Ctrl+A / Ctrl+C でコピーしたテキスト（domain.md『スコア入力フォーマット』の
実測形式）を想定する。

構造（実測仕様）:
    LEVEL 13                ← LEVEL ヘッダ（LEVEL クエリは内部 Lv インデックス）
    538/560                 ← 統計ブロック（CLEAR! 等の分母付きカウント、実測 21 行）
    ...
    13                      ← 曲ごと 3 行組: レベル / 曲名 / 達成率%＋ノーツ数
    Overdose
    99.4035%1,243 / 1,404

既知の課題（domain.md『既知の課題』）:
    コピペテキストには譜面難易度（BASIC〜Re:MASTER）と ST/DX の区別が含まれない。
    → 同一 (表示Lv, 曲名) に複数譜面がぶつかる衝突を検出して報告する。
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

try:
    from . import rating_core as rc
except ImportError:  # スクリプト直接実行のとき
    import rating_core as rc

# バージョン別ページ（record/musicVersion）のヘッダ行: バージョン名そのもの
# （例: 'CiRCLE PLUS'）。LEVEL 一覧の 'LEVEL 13' ヘッダに相当する位置に出る。
_VERSION_NAMES = frozenset(name for name, _code in rc.VERSION_CODES)

# ---------------------------------------------------------------------------
# 表示 Lv → 内部 Lv インデックス変換（domain.md『スコア入力フォーマット』）
# ---------------------------------------------------------------------------

_LEVEL_LABEL_RE = re.compile(r"^(\d{1,2})(\+?)$")
_LEVEL_MAX = 15
_LEVEL_PLUS_MIN = 7  # 7 以降は「+」が別段になる


def display_level_to_index(level_label: str) -> int:
    """表示 Lv（例: '13', '13+'）を内部 Lv インデックスへ変換する。

    対応式（実測）: レベル = N + max(0, N − 7)、'+' が付く場合はさらに +1。
    実測例: Lv13 → 19、Lv15 → 23。並びの見込み: Lv6=6 / Lv7=7 / Lv7+=8 / …
    Lv14=21 / Lv14+=22 / Lv15=23。
    """
    m = _LEVEL_LABEL_RE.match(level_label.strip())
    if not m:
        raise ValueError(f"invalid level label: {level_label!r}")
    n = int(m.group(1))
    has_plus = m.group(2) == "+"
    if not (1 <= n <= _LEVEL_MAX):
        raise ValueError(f"level out of range 1..{_LEVEL_MAX}: {n}")
    if has_plus and n >= _LEVEL_MAX:
        raise ValueError(f"Lv{n} has no '+' level: {level_label!r}")
    if has_plus and n < _LEVEL_PLUS_MIN:
        raise ValueError(f"'+' level does not exist below Lv{_LEVEL_PLUS_MIN}: {level_label!r}")
    return n + max(0, n - _LEVEL_PLUS_MIN) + (1 if has_plus else 0)


# ---------------------------------------------------------------------------
# パース結果のデータモデル
# ---------------------------------------------------------------------------

@dataclass
class ScoreRecord:
    """コピペ 1 譜面分のスコア（domain.md『正規化 CSV』のレコードに相当）。"""

    song_name: str
    display_level: str      # 表示Lv（例: '13', '13+'）
    level_index: int | None  # 内部 Lv インデックス（変換できない場合は None）
    achievement: float       # 達成率（%・4 桁小数）
    perfect_notes: int | None = None  # Perfect 数（任意）
    total_notes: int | None = None    # 総ノーツ数（任意）
    source_line: int = 0     # 元テキストの行番号（1 始まり・診断用）
    difficulty: str | None = None  # 譜面難易度（バージョン別ページで判明する場合）
    page_version: str | None = None  # バージョン別ページの版（例: 'CiRCLE PLUS'）

    @property
    def is_ap_like(self) -> bool:
        """達成率 100.00% 以上か（AP の近似判定。domain.md『AP ボーナス』参照）。"""
        return self.achievement >= 100.0


@dataclass
class ParseResult:
    """コピペテキストのパース結果。"""

    records: list[ScoreRecord] = field(default_factory=list)
    # 衝突（同一 表示Lv + 曲名 が複数行）の検出結果。
    # NET の LEVEL 一覧では MASTER と Re:MASTER・ST と DX が同 Lv だと
    # 同一 (表示Lv, 曲名) の行が並ぶため、コピペだけでは区別できない。
    conflicts: list[tuple[str, str, int]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # 読み取った LEVEL ヘッダの一覧 (ラベル, 内部インデックス)
    level_sections: list[tuple[str, int]] = field(default_factory=list)
    # 読み取ったバージョンヘッダの一覧（例: ['CiRCLE PLUS']。バージョン別ページ用）
    version_sections: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 行パターン
# ---------------------------------------------------------------------------

_HEADER_RE = re.compile(r"^LEVEL\s*(\d{1,2})(\+?)\s*$")
# 達成率行: 例 '99.4035%1,243 / 1,404'（ノーツ数部分は任意・カンマ区切り許容）
_ACHIEVEMENT_RE = re.compile(
    r"^(\d{1,3}(?:\.\d{1,4})?)\s*%\s*(?:([\d,]+)\s*/\s*([\d,]+))?\s*$"
)
# 統計ブロックの行: 'CLEAR! 538/560' '538/560' '★1 150/560' 等。
# 実測 21 行だが、行数に依存しない（パターンで判定して読み飛ばす）。
# '99.4035%…' のような達成率行は '%' を含むため対象外。
_STATS_LINE_RE = re.compile(r"^[^%]*\d[\d,]*\s*/\s*\d[\d,]*$")


def parse_paste(text: str) -> ParseResult:
    """コピペテキストをパースして ScoreRecord のリストを返す。

    曲ごとの 3 行組（レベル / 曲名 / 達成率行）は「達成率行」を目印に
    逆方向へたどって認識する（統計ブロックの行数変化に影響されない）。
    """
    result = ParseResult()
    lines = text.splitlines()
    header_label: str | None = None
    header_index: int | None = None
    page_version: str | None = None

    for i, raw in enumerate(lines):
        line = raw.strip()
        if not line:
            continue

        # バージョン別ページ（record/musicVersion）のヘッダ行（例: 'CiRCLE PLUS'）。
        # コピペ本文にバージョン名のみの行はここ以外に現れない想定。
        if line in _VERSION_NAMES:
            page_version = line
            result.version_sections.append(line)
            continue

        m = _HEADER_RE.match(line)
        if m:
            label = m.group(1) + m.group(2)
            header_label, header_index = label, display_level_to_index(label)
            page_version = None  # LEVEL ページの途中からの混在に備え、バージョン情報をリセット
            result.level_sections.append((label, header_index))
            continue

        m = _ACHIEVEMENT_RE.match(line)
        if not m:
            continue

        achievement = float(m.group(1))
        perfect = int(m.group(2).replace(",", "")) if m.group(2) else None
        total = int(m.group(3).replace(",", "")) if m.group(3) else None

        # 曲名 = 達成率行の直前の非空行
        name_line = _prev_nonempty(lines, i - 1)
        # レベル行 = 曲名行のさらに前の非空行
        level_line = _prev_nonempty(lines, (name_line[0] - 1) if name_line else -1)

        name: str | None = None
        display_level = header_label
        warnings: list[str] = []

        if name_line is not None:
            name_text = name_line[1]
            if (
                _HEADER_RE.match(name_text)
                or _ACHIEVEMENT_RE.match(name_text)
                or _STATS_LINE_RE.match(name_text)
            ):
                # 3 行組の構造が壊れている（曲名行が欠ける等）
                warnings.append(
                    f"line {i + 1}: 曲名行が欠けている可能性（直前行が曲名として不自然）"
                )
            else:
                name = name_text
        if name is None:
            result.warnings.extend(warnings)
            result.warnings.append(
                f"line {i + 1}: 曲名が特定できずスキップしました（達成率 {achievement}%）"
            )
            continue

        lm = _LEVEL_LABEL_RE.match(level_line[1]) if level_line else None
        if lm:
            display_level = lm.group(1) + lm.group(2)
        elif display_level is None:
            result.warnings.append(
                f"line {i + 1}: レベル行・LEVEL ヘッダが見つからずスキップしました"
            )
            continue
        else:
            result.warnings.append(
                f"line {i + 1}: レベル行が見つからないため LEVEL ヘッダ（{display_level}）を使用しました"
            )

        try:
            level_index = display_level_to_index(display_level)
        except ValueError as exc:
            level_index = None
            result.warnings.append(f"line {i + 1}: {exc}")

        result.records.append(
            ScoreRecord(
                song_name=name,
                display_level=display_level,
                level_index=level_index,
                achievement=achievement,
                perfect_notes=perfect,
                total_notes=total,
                source_line=i + 1,
                page_version=page_version,
            )
        )

    # 衝突検出: 同一 (表示Lv, 曲名) が 2 行以上
    counts = Counter((r.display_level, r.song_name) for r in result.records)
    result.conflicts = [
        (lv, name, n) for (lv, name), n in sorted(counts.items()) if n >= 2
    ]
    for lv, name, n in result.conflicts:
        result.warnings.append(
            f"衝突: LEVEL {lv} の『{name}』が {n} 行あります"
            "（譜面難易度 / ST・DX の区別はコピペに含まれないため確定できません）"
        )
    return result


def _prev_nonempty(lines: list[str], start: int) -> tuple[int, str] | None:
    """start 行から上方向へ最初の非空行を返す（行番号, 内容）。見つからなければ None。"""
    j = start
    while j >= 0:
        text = lines[j].strip()
        if text:
            return (j, text)
        j -= 1
    return None


def is_stats_line(line: str) -> bool:
    """統計ブロックの行（CLEAR! 538/560 等）かどうか。

    パース本体は達成率行を目印にするためこの判定は使わないが、
    デバッグ・テスト補助のために公開する。
    """
    return bool(_STATS_LINE_RE.match(line.strip()))
