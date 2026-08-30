"""maimai でらっくすNET のスコアをパースする（PoC）。

入力は 2 種類:
- コピペテキスト: 「レコード → 楽曲スコア → LEVEL」の一覧画面を Ctrl+A / Ctrl+C で
  コピーしたテキスト（domain.md『スコア入力フォーマット』の実測形式）。
- ページ保存 HTML: 同じ一覧画面をブラウザでページ保存した HTML。
  画像 src（diff_*.png / music_dx.png / music_standard.png）から
  譜面難易度と ST/DX を確定できる。

コピペテキスト構造（実測仕様）:
    LEVEL 13                ← LEVEL ヘッダ（LEVEL クエリは内部 Lv インデックス）
    538/560                 ← 統計ブロック（CLEAR! 等の分母付きカウント、実測 21 行）
    ...
    13                      ← 曲ごと 3 行組: レベル / 曲名 / 達成率%＋ノーツ数
    Overdose
    98.7654%1,234 / 1,345

既知の課題（domain.md『既知の課題』）:
    コピペテキストには譜面難易度（BASIC〜Re:MASTER）と ST/DX の区別が含まれない。
    → 同一 (表示Lv, 曲名) に複数譜面がぶつかる衝突を検出して報告する。
    （HTML パースでは画像 src から確定できるため衝突にならない）
"""

from __future__ import annotations

import html.parser
import json
import os
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
    system: str | None = None  # 'ST' | 'DX'（HTML パースで判明する場合）
    page_version: str | None = None  # バージョン別ページの版（例: 'CiRCLE PLUS'）

    @property
    def is_ap_like(self) -> bool:
        """達成率 100.00% 以上か（AP の近似判定。domain.md『AP ボーナス』参照）。"""
        return self.achievement >= 100.0


@dataclass
class UnplayedChart:
    """スコア記録のない（未プレイの）譜面エントリ。

    実測では未プレイ曲はスコアブロック自体が存在しないため、達成率を
    読み取れないエントリとして検出される（RATING 対象外）。
    """

    song_name: str
    display_level: str
    difficulty: str | None = None
    system: str | None = None
    source_line: int = 0


@dataclass
class ParseResult:
    """コピペテキスト / HTML のパース結果。"""

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
    # 未プレイ（スコア記録なし）の譜面エントリ（HTML パースで検出）
    unplayed: list[UnplayedChart] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 行パターン
# ---------------------------------------------------------------------------

_HEADER_RE = re.compile(r"^LEVEL\s*(\d{1,2})(\+?)\s*$")
# 達成率行: 例 '98.7654%1,234 / 1,345'（ノーツ数部分は任意・カンマ区切り許容）
_ACHIEVEMENT_RE = re.compile(
    r"^(\d{1,3}(?:\.\d{1,4})?)\s*%\s*(?:([\d,]+)\s*/\s*([\d,]+))?\s*$"
)
# 統計ブロックの行: 'CLEAR! 538/560' '538/560' '★1 150/560' 等。
# 実測 21 行だが、行数に依存しない（パターンで判定して読み飛ばす）。
# '98.7654%…' のような達成率行は '%' を含むため対象外。
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


# ---------------------------------------------------------------------------
# HTML パース（ページ保存したレコード一覧）
# ---------------------------------------------------------------------------

# 画像 src のファイル名（拡張子 .png を除いた部分）→ 譜面難易度 / 系統
_DIFFICULTY_IMG_NAMES = {
    "diff_basic": "BASIC",
    "diff_advanced": "ADVANCED",
    "diff_expert": "EXPERT",
    "diff_master": "MASTER",
    "diff_remaster": "Re:MASTER",
}
_SYSTEM_IMG_NAMES = {
    "music_dx": "DX",
    "music_standard": "ST",
}
# スコアブロック内のノーツ数行: 例 '2,188 / 4,026'（カンマ区切り許容）
_NOTES_RE = re.compile(r"^([\d,]+)\s*/\s*([\d,]+)$")


def looks_like_html(text: str) -> bool:
    """ページ保存 HTML かどうかを判別する（実測マーカー: musicDetail フォームの存在）。"""
    return "<form" in text and "musicDetail" in text


class _MusicDetailParser(html.parser.HTMLParser):
    """record/musicLevel の譜面エントリを収集する HTML パーサ。

    1 譜面 = 1 <form action=".../record/musicDetail/"> を単位とし、
    フォーム開始で新しいエントリ、</form> で確定する。Lv 選択フォーム等の
    他フォームは action に musicDetail を含まないため対象外。
    """

    _MUSIC_FORM_ACTION = "musicdetail"
    _LV_CLASS = "music_lv_block"
    _NAME_CLASS = "music_name_block"
    _SCORE_CLASS = "music_score_block"

    def __init__(self, result: ParseResult) -> None:
        super().__init__(convert_charrefs=True)
        self.result = result
        self.in_entry = False
        self.entry_line = 0
        self._current: dict[str, object] | None = None
        # フォーム内で開いている div のスタック（(class 文字列, 収集テキスト)）
        self._div_stack: list[tuple[str, list[str]]] = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            if self._MUSIC_FORM_ACTION in attrs.get("action", "").lower():
                self.in_entry = True
                self.entry_line = self.getpos()[0]
                self._div_stack.clear()  # 直前エントリの残骸を掃除
                self._current = {
                    "difficulty": None, "system": None,
                    "display_level": None, "song_name": None,
                    "achievement": None, "perfect_notes": None, "total_notes": None,
                }
            return
        if not self.in_entry:
            return
        if tag == "img":
            base = os.path.basename(attrs.get("src", "").split("?", 1)[0])
            if base.endswith(".png"):
                base = base[:-4]
            if base in _DIFFICULTY_IMG_NAMES:
                self._current["difficulty"] = _DIFFICULTY_IMG_NAMES[base]
            elif base in _SYSTEM_IMG_NAMES:
                self._current["system"] = _SYSTEM_IMG_NAMES[base]
            return
        if tag == "div":
            self._div_stack.append((attrs.get("class", ""), []))

    def handle_data(self, data):
        if self.in_entry and self._div_stack:
            self._div_stack[-1][1].append(data)

    def handle_endtag(self, tag):
        if tag == "form":
            if self.in_entry:
                self._finalize_entry()
                self.in_entry = False
                self._current = None
            return
        if tag == "div" and self.in_entry and self._div_stack:
            classes, parts = self._div_stack.pop()
            self._apply_div_text(classes, "".join(parts).strip())

    def _apply_div_text(self, classes: str, text: str) -> None:
        if self._current is None:
            return
        if self._LV_CLASS in classes:
            self._current["display_level"] = text
        elif self._NAME_CLASS in classes:
            self._current["song_name"] = text
        elif self._SCORE_CLASS in classes:
            m = _ACHIEVEMENT_RE.match(text)
            if m:
                self._current["achievement"] = float(m.group(1))
            else:
                m = _NOTES_RE.match(text)
                if m:
                    self._current["perfect_notes"] = int(m.group(1).replace(",", ""))
                    self._current["total_notes"] = int(m.group(2).replace(",", ""))

    def _finalize_entry(self) -> None:
        cur = self._current
        assert cur is not None
        line = self.entry_line
        if cur["song_name"] is None:
            self.result.warnings.append(
                f"line {line}: 曲名が見つからずスキップしました（HTML エントリ）"
            )
            return
        if cur["display_level"] is None:
            self.result.warnings.append(
                f"line {line}: Lv が見つからずスキップしました: {cur['song_name']}"
            )
            return
        if cur["achievement"] is None:
            # 未プレイ曲はスコアブロック自体が存在しない（実測事実）→ RATING 対象外
            self.result.unplayed.append(
                UnplayedChart(
                    song_name=cur["song_name"],
                    display_level=cur["display_level"],
                    difficulty=cur["difficulty"],
                    system=cur["system"],
                    source_line=line,
                )
            )
            return
        try:
            level_index = display_level_to_index(cur["display_level"])
        except ValueError as exc:
            level_index = None
            self.result.warnings.append(f"line {line}: {exc}")
        self.result.records.append(
            ScoreRecord(
                song_name=cur["song_name"],
                display_level=cur["display_level"],
                level_index=level_index,
                achievement=cur["achievement"],
                perfect_notes=cur["perfect_notes"],
                total_notes=cur["total_notes"],
                source_line=line,
                difficulty=cur["difficulty"],
                system=cur["system"],
            )
        )


def parse_html(html_text: str) -> ParseResult:
    """ページ保存した HTML からスコアをパースする。

    record/musicLevel（LEVEL 一覧）の「1 譜面 = 1 musicDetail フォーム」構造を
    パースし、画像 src（diff_*.png / music_dx.png / music_standard.png）から
    譜面難易度と ST/DX を確定する（コピペテキストで確定できない課題の解消）。
    達成率の無いエントリは未プレイ曲として unplayed に記録する。
    """
    result = ParseResult()
    parser = _MusicDetailParser(result)
    parser.feed(html_text)
    parser.close()

    _detect_conflicts(result)
    return result


def _detect_conflicts(result: ParseResult) -> None:
    """同一 (表示Lv, 曲名, 系統, 譜面難易度) の重複を衝突として検出する。

    parse_html / parse_bookmark_json 共通。HTML・JSON はコピペと違い譜面が
    確定するため、コピペの (表示Lv, 曲名) キーより細かいキーで数える。
    conflicts のタプル形式は parse_paste と同様 (表示Lv, 曲名, 件数)。
    """
    counts = Counter(
        (r.display_level, r.song_name, r.system, r.difficulty) for r in result.records
    )
    result.conflicts = [
        (lv, name, n)
        for (lv, name, _system, _difficulty), n in sorted(counts.items())
        if n >= 2
    ]
    for lv, name, n in result.conflicts:
        result.warnings.append(
            f"衝突: LEVEL {lv} の『{name}』が {n} エントリあります"
            "（同一の表示Lv・曲名・系統・譜面難易度の重複）"
        )


# ---------------------------------------------------------------------------
# ブックマークレット JSON 入力（tools/bookmarklet.html）
# ---------------------------------------------------------------------------

_BOOKMARK_DIFFICULTIES = frozenset(_DIFFICULTY_IMG_NAMES.values())


def looks_like_bookmark_json(text: str) -> bool:
    """ブックマークレット出力の JSON かどうかを大まかに判定する。"""
    head = text.lstrip()
    return head.startswith("{") and '"entries"' in text[:2000]


def parse_bookmark_json(json_text: str) -> ParseResult:
    """ブックマークレット出力のスコア JSON をパースする。

    形式（tools/bookmarklet.html の出力仕様）:
        {"source": "...", "page": {"level": 19, ...}, "entries": [
            {"song": "曲名", "level": "13+", "difficulty": "MASTER",
             "system": "DX", "achievement": 98.7654,
             "perfect": 1234, "total": 1345, "idx": "..."}
        ]}
    HTML 入力と同様、画像情報から譜面難易度・ST/DX が確定済みのデータ。
    achievement が無いエントリは未プレイ曲として unplayed に記録する。
    """
    try:
        data = json.loads(json_text)
    except ValueError as exc:
        raise ValueError(f"ブックマークレット JSON をパースできません: {exc}") from exc
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise ValueError("ブックマークレット JSON に 'entries' 配列がありません")
    result = ParseResult()
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            result.warnings.append(f"エントリ {i}: dict ではありません（スキップ）")
            continue
        song = entry.get("song")
        level_label = entry.get("level")
        if not (isinstance(song, str) and song):
            result.warnings.append(f"エントリ {i}: song が読めません（スキップ）")
            continue
        if not (isinstance(level_label, str) and level_label):
            result.warnings.append(f"エントリ {i}: level が読めません: {song}（スキップ）")
            continue
        system = entry.get("system")
        if system not in ("ST", "DX", None):
            result.warnings.append(f"エントリ {i}: system が不明です: {system!r}（無視します）")
            system = None
        difficulty = entry.get("difficulty")
        if difficulty not in _BOOKMARK_DIFFICULTIES and difficulty is not None:
            result.warnings.append(
                f"エントリ {i}: difficulty が不明です: {difficulty!r}（無視します）"
            )
            difficulty = None
        achievement = entry.get("achievement")
        if achievement is None:
            result.unplayed.append(
                UnplayedChart(
                    song_name=song, display_level=level_label,
                    difficulty=difficulty, system=system, source_line=i + 1,
                )
            )
            continue
        try:
            achievement = float(achievement)
        except (TypeError, ValueError):
            result.warnings.append(
                f"エントリ {i}: achievement が数値でありません: {achievement!r}（スキップ）"
            )
            continue

        def _int_field(key: str) -> int | None:
            value = entry.get(key)
            if value is None:
                return None
            try:
                return int(value)
            except (TypeError, ValueError):
                result.warnings.append(
                    f"エントリ {i}: {key} が数値でありません: {value!r}（無視します）"
                )
                return None

        try:
            level_index = display_level_to_index(level_label)
        except ValueError as exc:
            level_index = None
            result.warnings.append(f"エントリ {i}: {exc}")
        result.records.append(
            ScoreRecord(
                song_name=song,
                display_level=level_label,
                level_index=level_index,
                achievement=achievement,
                perfect_notes=_int_field("perfect"),
                total_notes=_int_field("total"),
                source_line=i + 1,
                difficulty=difficulty,
                system=system,
            )
        )
    _detect_conflicts(result)
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
