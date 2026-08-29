"""maimai でらっくす RATING 計算コア（PoC・純関数のみ）。

仕様の正: projects/_labs/maimai_dx_rating_calc/docs/domain.md
- 『単曲レート値』: floor(譜面定数 × 達成率(実数) × Rank係数) + APボーナス
- 『達成率』: 入力 0〜101%、算出時に 100.5% (=1.005) で cap
- 『Rank係数』: 昇順しきい値テーブル + 逆順ループ（境界の寸止め行を含む）
- 『枠の定義（新曲枠 / ベスト枠）』: 新曲枠 15 / ベスト枠 35、Re:MASTER の例外あり

外部状態を持たない純関数のみで構成する（PoC の方針）。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# 達成率の入力範囲と天井（domain.md『達成率』）
# ---------------------------------------------------------------------------

ACHIEVEMENT_INPUT_MIN = 0.0    # 入力下限 0%
ACHIEVEMENT_INPUT_MAX = 101.0  # 入力上限 101%（AP+ の理論値）
ACHIEVEMENT_CAP = 100.5        # 算出時の天井 100.5%（= 1.005）

# 達成率は 4 桁小数（NET 実測仕様）、譜面定数は小数第 1 位まで。
# 浮動小数の誤差を避けるため、内部では整数にスケールして全て整数演算で行う。
#   ach_x   = 達成率% × 10^4（4 桁小数 → 整数）
#   const_x = 譜面定数 × 10（1 桁小数 → 整数）
#   coef_x  = 係数 × 10（1 桁小数 → 整数）
# 単曲レート値 = floor(const_x * ach_x * coef_x / 10^8)
#   （const × ach%/100 × coef = const_x/10 × ach_x/10^6 × coef_x/10）
_RATE_DENOMINATOR = 10**8

# ---------------------------------------------------------------------------
# Rank係数テーブル（domain.md『Rank係数』を昇順しきい値で正確に移植）
# (しきい値 達成率%, 係数, ランク名) の昇順並び。
# 「境界寸止め」行（100.4999 / 99.9999 / 98.9999 / 96.9999 / 79.9999）を含む。
# ---------------------------------------------------------------------------

RANK_COEFFICIENTS: tuple[tuple[float, float, str], ...] = (
    (0.0, 0.0, "D"),        # < 10.0000 は係数 0.0
    (10.0000, 1.6, "D"),
    (20.0000, 3.2, "D"),
    (30.0000, 4.8, "D"),
    (40.0000, 6.4, "D"),
    (50.0000, 8.0, "C"),
    (60.0000, 9.6, "B"),
    (70.0000, 11.2, "BB"),
    (75.0000, 12.0, "BBB"),
    (79.9999, 12.8, "BBB"),  # 境界寸止め
    (80.0000, 13.6, "A"),
    (90.0000, 15.2, "AA"),
    (94.0000, 16.8, "AAA"),
    (96.9999, 17.6, "AAA"),  # 境界寸止め
    (97.0000, 20.0, "S"),
    (98.0000, 20.3, "S+"),
    (98.9999, 20.6, "S+"),   # 境界寸止め
    (99.0000, 20.8, "SS"),
    (99.5000, 21.1, "SS+"),
    (99.9999, 21.4, "SS+"),  # 境界寸止め
    (100.0000, 21.6, "SSS"),
    (100.4999, 22.2, "SSS"),  # 境界寸止め
    (100.5000, 22.4, "SSS+"),
)

# 整数スケール済みしきい値テーブル（昇順）。逆順ループで判定する。
_COEF_TABLE_X: tuple[tuple[int, int], ...] = tuple(
    (round(th * 10000), round(coef * 10)) for th, coef, _label in RANK_COEFFICIENTS
)


def capped_achievement(achievement: float) -> float:
    """達成率(%)を入力範囲で検証し、算出用の値（100.5% 天井）で返す。

    domain.md『達成率』: 入力は 0〜101% を受け付け、算出時に 100.5% で cap する。
    """
    if not (ACHIEVEMENT_INPUT_MIN <= achievement <= ACHIEVEMENT_INPUT_MAX):
        raise ValueError(
            f"achievement must be within {ACHIEVEMENT_INPUT_MIN}..{ACHIEVEMENT_INPUT_MAX} (%): {achievement}"
        )
    return min(achievement, ACHIEVEMENT_CAP)


def rank_coefficient(achievement: float) -> float:
    """達成率(%)に対応する Rank係数を返す（100.5% cap 適用後）。

    昇順しきい値テーブルを逆順ループし、ach >= しきい値 となる最大のしきい値の
    係数を返す（domain.md『Rank係数』の実装指示どおり）。
    """
    ach = capped_achievement(achievement)
    ach_x = _to_scaled_int(ach, 10000, "achievement")
    for th_x, coef_x in reversed(_COEF_TABLE_X):
        if ach_x >= th_x:
            return coef_x / 10
    return 0.0  # テーブル先頭（0.0%）が常にマッチするため到達しない


def _to_scaled_int(value: float, scale: int, name: str) -> int:
    """小数値を指定スケールの整数へ変換（誤差チェック付き）。"""
    scaled = value * scale
    rounded = round(scaled)
    if abs(scaled - rounded) > 1e-3:
        raise ValueError(f"{name} has more decimal places than supported: {value}")
    return int(rounded)


def single_rate(const: float, achievement: float, is_ap: bool = False) -> int:
    """単曲レート値を返す。

    単曲レート値 = floor(譜面定数 × 達成率(実数) × Rank係数) + APボーナス
    - 達成率(実数) = 達成率(%) / 100、天井 100.5%（domain.md『達成率』）
    - APボーナス = 1（achievement >= 100.00 または is_ap、domain.md『AP ボーナス』）
      ※ achievement >= 100.00 は AP の近似判定（domain.md『AP ボーナス』参照）
    - 譜面定数は小数第 1 位まで（domain.md『譜面定数』）

    全て整数演算で計算するため、境界値でも浮動小数誤差が発生しない。
    """
    if const < 0:
        raise ValueError(f"constant must be >= 0: {const}")
    const_x = _to_scaled_int(const, 10, "constant")
    ach = capped_achievement(achievement)
    ach_x = _to_scaled_int(ach, 10000, "achievement")
    coef_x = 0  # テーブル先頭（しきい値 0.0）が常にマッチするため 0 のまま通らない
    for th_x, c_x in reversed(_COEF_TABLE_X):
        if ach_x >= th_x:
            coef_x = c_x
            break
    rate = (const_x * ach_x * coef_x) // _RATE_DENOMINATOR
    if ach_x >= 1_000_000 or is_ap:  # 達成率 100.0000% 以上で AP ボーナス
        rate += 1
    return rate


# ---------------------------------------------------------------------------
# version コード（domain.md『version コード → バージョン名（帯判定）』）
# ---------------------------------------------------------------------------

VERSION_CODES: tuple[tuple[str, int], ...] = (
    ("maimai", 10000),
    ("maimai PLUS", 11000),
    ("GreeN", 12000),
    ("GreeN PLUS", 13000),
    ("ORANGE", 14000),
    ("ORANGE PLUS", 15000),
    ("PiNK", 16000),
    ("PiNK PLUS", 17000),
    ("MURASAKi", 18000),
    ("MURASAKi PLUS", 18500),
    ("MiLK", 19000),
    ("MiLK PLUS", 19500),
    ("FiNALE", 19900),
    ("でらっくす", 20000),
    ("でらっくす PLUS", 20500),
    ("Splash", 21000),
    ("Splash PLUS", 21500),
    ("UNiVERSE", 22000),
    ("UNiVERSE PLUS", 22500),
    ("FESTiVAL", 23000),
    ("FESTiVAL PLUS", 23500),
    ("BUDDiES", 24000),
    ("BUDDiES PLUS", 24500),
    ("PRiSM", 25000),
    ("PRiSM PLUS", 25500),
    ("CiRCLE", 26000),
    ("CiRCLE PLUS", 26500),
)

CURRENT_VERSION_NAME = "CiRCLE PLUS"  # 2026-03-19 稼働（現行）


def version_floor(code: int) -> int:
    """version 内部コードの基準コード（フロア判定）を返す。

    domain.md『version コード → バージョン名（帯判定）』:
    version >= 基準コード となる最大の基準コードを採用（例: 26501 → 26500）。
    """
    bases = [c for _name, c in VERSION_CODES]
    if code < bases[0]:
        raise ValueError(f"version code is older than maimai (10000): {code}")
    floor = bases[0]
    for c in bases:
        if code >= c:
            floor = c
    return floor


def version_name(code: int) -> str:
    """version 内部コードをバージョン名に変換する（フロア判定経由）。"""
    floor = version_floor(code)
    for name, c in VERSION_CODES:
        if c == floor:
            return name
    raise ValueError(f"unknown version code: {code}")


def version_code_from(name_or_code: str) -> int:
    """バージョン名（例: 'CiRCLE PLUS'）またはコード文字列（例: '26500'）をコードへ変換する。"""
    text = name_or_code.strip()
    if text.isdigit():
        return version_floor(int(text))
    for name, c in VERSION_CODES:
        if name == text:
            return c
    raise ValueError(f"unknown version name or code: {name_or_code!r}")


def previous_version_code(current: int) -> int:
    """一つ前のバージョンの基準コードを返す（現行バージョンの直前の基準コード）。"""
    current_floor = version_floor(current)
    bases = [c for _name, c in VERSION_CODES]
    lower = [c for c in bases if c < current_floor]
    if not lower:
        raise ValueError(f"no previous version before {current}")
    return lower[-1]


# ---------------------------------------------------------------------------
# 枠選定（domain.md『枠の定義（新曲枠 / ベスト枠）』『Re:MASTER の例外』）
# ---------------------------------------------------------------------------

NEW_FRAME_SIZE = 15
BEST_FRAME_SIZE = 35

DIFFICULTY_REMASTER = "Re:MASTER"


@dataclass(frozen=True)
class ScoredChart:
    """単曲レート値が確定した譜面スコア（枠選定への入力）。"""

    song_name: str
    system: str            # 'ST' | 'DX'
    difficulty: str        # BASIC / ADVANCED / EXPERT / MASTER / Re:MASTER
    level: str             # 表示Lv（例: '13', '13+'）
    constant: float        # 譜面定数
    achievement: float     # 達成率（%）
    rate: int              # 単曲レート値（AP ボーナス込み）
    is_ap: bool            # AP ボーナスが付いたか
    added_version: int | None  # この譜面の追加バージョン（基準コード帯。未登録は None）
    song_base_version: int | None  # 楽曲の BASIC〜MASTER 追加バージョン（Re:M 例外判定用）


def is_new_candidate(chart: ScoredChart, current_version: int) -> bool:
    """譜面が新曲枠の候補かどうか（domain.md『Re:MASTER の例外』の判定ロジック）。

    is_new_candidate(chart) =
        chart.added_version ∈ {current_version, prev_version}
        AND NOT ( chart.difficulty == Re:MASTER
                  AND song の BASIC〜MASTER の最古追加version < chart.added_version )

    added_version が不明（マスタ未登録など）の譜面は新曲枠の候補としない。
    added_version は基準コード帯（26500 等）を想定するが、生のコード
    （26501 等の小数点コード）が入ってもフロア判定で正規化して比較する。
    """
    if chart.added_version is None:
        return False
    prev = previous_version_code(current_version)
    window = {version_floor(current_version), prev}
    if version_floor(chart.added_version) not in window:
        return False
    if chart.difficulty == DIFFICULTY_REMASTER:
        if chart.song_base_version is None:
            return False
        if chart.song_base_version < chart.added_version:
            return False
    return True


def _frame_sort_key(chart: ScoredChart) -> tuple:
    """枠内の並び順（同点時の順位決め込み）。

    単曲レート値降順を第一基準とし、同点のときは
    譜面定数が大きい方 → 達成率が高い方 → 曲名 → 系統 → 譜面難易度 の順で決める。
    （同点時の扱いは domain.md 未規定のため PoC での暫定方針。README 参照）
    """
    return (
        -chart.rate,
        -chart.constant,
        -chart.achievement,
        chart.song_name,
        chart.system,
        chart.difficulty,
    )


def select_frames(
    scores: list[ScoredChart], current_version: int
) -> tuple[list[ScoredChart], list[ScoredChart]]:
    """スコアを新曲枠（上位15）とベスト枠（上位35）に選定する。

    - 新曲枠: is_new_candidate() が真の譜面のうち単曲レート値上位 15
    - ベスト枠: 新曲枠の候補とならない全譜面（『枠の定義』）のうち単曲レート値上位 35
      ※ 新曲枠の候補で選もれになった譜面はベスト枠に回らず圏外になる
       （公式の説明では枠の区分は「楽曲が登場したバージョン」基準のため）
    - 戻り値はそれぞれ単曲レート値降順（同点時は _frame_sort_key 基準）
    """
    new_candidates = [c for c in scores if is_new_candidate(c, current_version)]
    best_candidates = [c for c in scores if not is_new_candidate(c, current_version)]

    new_sorted = sorted(new_candidates, key=_frame_sort_key)
    best_sorted = sorted(best_candidates, key=_frame_sort_key)

    new_frame = new_sorted[:NEW_FRAME_SIZE]
    best_frame = best_sorted[:BEST_FRAME_SIZE]
    return new_frame, best_frame


def calc_rating(new_frame: list[ScoredChart], best_frame: list[ScoredChart]) -> int:
    """RATING を返す（新曲枠 + ベスト枠の単曲レート値の合計、最終も切捨て）。

    domain.md『RATING の全体構造』:
    RATING = Σ 単曲レート値（新曲枠 上位15譜面） + Σ 単曲レート値（ベスト枠 上位35譜面）
             + APボーナス（単曲レート値に AP 分の +1 が既に織り込み済み）
    """
    total = sum(c.rate for c in new_frame) + sum(c.rate for c in best_frame)
    return math.floor(total)
