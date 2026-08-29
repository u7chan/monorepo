"""rating_core / net_parser / run のテスト（stdlib unittest のみで動作）。

実行例:
    python3 -m unittest poc/test_rating.py          (リポジトリルートから)
    python3 -m unittest discover -s poc -p "test_*.py"
"""

from __future__ import annotations

import os
import sys
import unittest

try:
    from . import rating_core as rc
    from . import net_parser as np
except ImportError:  # スクリプト直接実行（python3 poc/test_rating.py）のとき
    import rating_core as rc
    import net_parser as np


class TestRankCoefficient(unittest.TestCase):
    """Rank係数テーブルの境界（domain.md『Rank係数』、寸止め行を含む）。"""

    def test_boundaries(self):
        cases = [
            (100.5000, 22.4),
            (100.4999, 22.2),  # 境界寸止め
            (100.0000, 21.6),
            (99.9999, 21.4),   # 境界寸止め
            (99.5000, 21.1),
            (99.0000, 20.8),
            (98.9999, 20.6),   # 境界寸止め
            (98.0000, 20.3),
            (97.0000, 20.0),
            (96.9999, 17.6),   # 境界寸止め
            (94.0000, 16.8),
            (90.0000, 15.2),
            (80.0000, 13.6),
            (79.9999, 12.8),   # 境界寸止め
            (75.0000, 12.0),
            (70.0000, 11.2),
            (60.0000, 9.6),
            (50.0000, 8.0),
            (40.0000, 6.4),
            (30.0000, 4.8),
            (20.0000, 3.2),
            (10.0000, 1.6),
            (9.9999, 0.0),
            (0.0, 0.0),
        ]
        for ach, coef in cases:
            with self.subTest(achievement=ach):
                self.assertEqual(rc.rank_coefficient(ach), coef)

    def test_cap_above_100_5(self):
        # 100.5% を超える入力は全て 100.5% 扱い（domain.md『達成率』）
        self.assertEqual(rc.rank_coefficient(100.5001), 22.4)
        self.assertEqual(rc.rank_coefficient(101.0), 22.4)

    def test_table_is_ascending_by_threshold(self):
        ths = [th for th, _coef, _label in rc.RANK_COEFFICIENTS]
        self.assertEqual(ths, sorted(ths))
        # 寸止め行が欠けていないこと（5 行）
        suridome = [100.4999, 99.9999, 98.9999, 96.9999, 79.9999]
        for th in suridome:
            self.assertIn(th, ths)


class TestSingleRate(unittest.TestCase):
    """単曲レート値の境界値テスト。"""

    # const=14.0 で達成率境界を撃つ（期待値は整数演算による手計算）
    BOUNDARY_CASES = [
        (99.4999, 289),   # 14.0 × 0.994999 × 20.8 = 289.743… → 289（SS 係数）
        (99.5000, 293),   # 14.0 × 0.995    × 21.1 = 293.923… → 293（SS+ 係数）
        (99.9999, 299),   # 14.0 × 0.999999 × 21.4 = 299.599… → 299（SS+ 寸止め係数）
        (100.0000, 303),  # 14.0 × 1.0      × 21.6 = 302.4   → 302 +1（AP ボーナス）
        (100.4999, 313),  # 14.0 × 1.004999 × 22.2 = 312.353… → 312 +1（SSS 寸止め係数）
        (100.5000, 316),  # 14.0 × 1.005    × 22.4 = 315.168… → 315 +1（SSS+ 係数）
        (100.5001, 316),  # 100.5% で cap され 100.5000 と同一結果
        (101.0000, 316),  # 同上（101% 理論値も天井）
    ]

    def test_achievement_boundaries_const14(self):
        for ach, expected in self.BOUNDARY_CASES:
            with self.subTest(achievement=ach):
                self.assertEqual(rc.single_rate(14.0, ach), expected)

    def test_suridome_rows_const10(self):
        # 寸止め行の係数が 1 つ下の帯と変わること
        cases = [
            (98.9999, 203),  # 20.6（98.9999 以上 S+ 寸止め）: 10 × 0.989999 × 20.6
            (99.0000, 205),  # 20.8
            (96.9999, 170),  # 17.6（97 未満は AAA に落ちる寸止め）
            (97.0000, 194),  # 20.0
            (79.9999, 102),  # 12.8（80 未満は BBB 帯の寸止め）
            (80.0000, 108),  # 13.6
            (9.9999, 0),     # 10 未満は係数 0
            (10.0000, 1),    # 10 × 1.0 × 1.6 = 1.6 → 1
        ]
        for ach, expected in cases:
            with self.subTest(achievement=ach):
                self.assertEqual(rc.single_rate(10.0, ach), expected)

    def test_floor_behavior(self):
        # 13.0 × 1.005 × 22.4 = 292.656 → 292 +1 = 293（domain.md の目安値計算と整合）
        self.assertEqual(rc.single_rate(13.0, 100.5), 293)
        # 14.0 × 1.005 × 22.4 = 315.168 → 315 +1 = 316
        self.assertEqual(rc.single_rate(14.0, 100.5), 316)
        # 13.0 × 0.97 × 20.0 = 252.2 → 252
        self.assertEqual(rc.single_rate(13.0, 97.0), 252)
        # 切捨確認: 端数があれば切り捨て
        self.assertEqual(rc.single_rate(13.3, 99.4035), 274)
        # 13.3 × 0.994035 × 20.8 = 274.989… → 274

    def test_ap_bonus(self):
        # 達成率 100.00 以上で +1（近似判定）
        self.assertEqual(rc.single_rate(14.0, 99.9999), 299)
        self.assertEqual(rc.single_rate(14.0, 100.0), 303)
        # 明示フラグでも +1（達成率が 100 未満でも付く）
        self.assertEqual(rc.single_rate(14.0, 99.5, is_ap=True), 294)
        self.assertEqual(rc.single_rate(14.0, 99.5), 293)
        # 101%（AP+ 理論値）は cap されて AP ボーナス込み
        self.assertEqual(rc.single_rate(13.5, 101.0), 304)
        # 13.5 × 1.005 × 22.4 = 303.912… → 303 +1

    def test_input_validation(self):
        for bad_ach in (-0.1, 101.5, -1.0, 1000.0):
            with self.subTest(achievement=bad_ach):
                with self.assertRaises(ValueError):
                    rc.single_rate(13.0, bad_ach)
        with self.assertRaises(ValueError):
            rc.single_rate(-1.0, 99.0)
        # サポート桁数を超える入力はエラー（定数 2 桁小数・達成率 5 桁小数）
        with self.assertRaises(ValueError):
            rc.single_rate(13.33, 99.0)
        with self.assertRaises(ValueError):
            rc.single_rate(13.0, 99.40355)

    def test_zero_cases(self):
        self.assertEqual(rc.single_rate(0.0, 100.0), 1)  # 0 × … = 0 +1（AP）
        self.assertEqual(rc.single_rate(13.0, 0.0), 0)   # 係数 0


class TestVersionCode(unittest.TestCase):
    """version コードのフロア判定（domain.md『version コード → バージョン名』）。"""

    def test_floor(self):
        cases = [
            (26501, 26500),  # 例: 26501 → CiRCLE PLUS
            (20003, 20000),  # 例: 20003 → でらっくす
            (11000, 11000),  # 例: 11000 → maimai PLUS
            (10000, 10000),
            (26514, 26500),
        ]
        for code, floor in cases:
            with self.subTest(code=code):
                self.assertEqual(rc.version_floor(code), floor)

    def test_names(self):
        self.assertEqual(rc.version_name(26500), "CiRCLE PLUS")
        self.assertEqual(rc.version_name(26000), "CiRCLE")
        self.assertEqual(rc.version_name(19900), "FiNALE")
        self.assertEqual(rc.version_name(10000), "maimai")

    def test_previous_version(self):
        self.assertEqual(rc.previous_version_code(26500), 26000)
        self.assertEqual(rc.previous_version_code(26000), 25500)
        self.assertEqual(rc.previous_version_code(11000), 10000)
        # 最初のバージョンより前は存在しない
        with self.assertRaises(ValueError):
            rc.previous_version_code(10000)

    def test_code_from_name_or_code(self):
        self.assertEqual(rc.version_code_from("CiRCLE PLUS"), 26500)
        self.assertEqual(rc.version_code_from("26500"), 26500)
        self.assertEqual(rc.version_code_from("26501"), 26500)
        with self.assertRaises(ValueError):
            rc.version_code_from("UNKNOWN")

    def test_too_old_code(self):
        with self.assertRaises(ValueError):
            rc.version_floor(9999)


class TestSelectFrames(unittest.TestCase):
    """枠選定（15 + 35 の境界、Re:M 例外、同点時）。"""

    def make(self, name, rate, added_version, difficulty="MASTER", system="DX",
             constant=13.5, achievement=99.0, song_base_version=None):
        if song_base_version is None:
            song_base_version = added_version
        return rc.ScoredChart(
            song_name=name, system=system, difficulty=difficulty, level="13",
            constant=constant, achievement=achievement, rate=rate, is_ap=False,
            added_version=added_version, song_base_version=song_base_version,
        )

    def test_window_current_and_prev(self):
        current = 26500
        scores = [
            self.make("cur", 300, 26500),
            self.make("prev", 290, 26000),
            self.make("old", 280, 25500),   # PRiSM PLUS → ベスト枠
            self.make("old2", 270, 20000),
        ]
        new_frame, best_frame = rc.select_frames(scores, current)
        self.assertEqual([c.song_name for c in new_frame], ["cur", "prev"])
        self.assertEqual([c.song_name for c in best_frame], ["old", "old2"])

    def test_limit_15_and_35(self):
        current = 26500
        # 新曲枠候補 20（上位 15 が枠入り、残り 5 は圏外）+ ベスト枠候補 40（上位 35 が枠入り）
        scores = []
        for i in range(20):
            scores.append(self.make(f"new{i:02d}", 300 - i, 26500))
        for i in range(40):
            scores.append(self.make(f"best{i:02d}", 200 - i, 20000))
        new_frame, best_frame = rc.select_frames(scores, current)
        self.assertEqual(len(new_frame), rc.NEW_FRAME_SIZE)
        self.assertEqual(len(best_frame), rc.BEST_FRAME_SIZE)
        self.assertEqual([c.song_name for c in new_frame], [f"new{i:02d}" for i in range(15)])
        self.assertEqual([c.song_name for c in best_frame], [f"best{i:02d}" for i in range(35)])
        # 選もれはベスト枠に回らない（枠の区分はバージョン基準のため）
        all_selected = {c.song_name for c in new_frame + best_frame}
        self.assertNotIn("new15", all_selected)
        self.assertNotIn("new19", all_selected)
        self.assertNotIn("best35", all_selected)

    def test_fewer_than_limit(self):
        current = 26500
        scores = [self.make("n1", 300, 26500), self.make("b1", 250, 20000)]
        new_frame, best_frame = rc.select_frames(scores, current)
        self.assertEqual(len(new_frame), 1)
        self.assertEqual(len(best_frame), 1)

    def test_remaster_exception_we_gonna_party_pattern(self):
        # Re:M が楽曲の B〜M 追加より後 → 楽曲が新曲ウィンドウ内でもベスト枠
        current = 26500
        scores = [
            self.make("later_remaster", 320, 26500, difficulty="Re:MASTER",
                      song_base_version=10000),
        ]
        new_frame, best_frame = rc.select_frames(scores, current)
        self.assertEqual(len(new_frame), 0)
        self.assertEqual([c.song_name for c in best_frame], ["later_remaster"])

    def test_remaster_added_with_song_is_new_candidate(self):
        # Re:M が楽曲収録と同じバージョン（Blows Up Everything パターン）→ 新曲枠候補
        current = 26500
        scores = [
            self.make("same_version_remaster", 320, 26500, difficulty="Re:MASTER",
                      song_base_version=26500),
        ]
        new_frame, best_frame = rc.select_frames(scores, current)
        self.assertEqual([c.song_name for c in new_frame], ["same_version_remaster"])
        self.assertEqual(len(best_frame), 0)

    def test_remaster_outside_window_is_best(self):
        # 過去バージョンの Re:M は単にベスト枠候補
        current = 26500
        scores = [self.make("old_remaster", 320, 21000, difficulty="Re:MASTER",
                            song_base_version=21000)]
        new_frame, best_frame = rc.select_frames(scores, current)
        self.assertEqual(len(new_frame), 0)
        self.assertEqual([c.song_name for c in best_frame], ["old_remaster"])

    def test_unknown_added_version_is_best_only(self):
        # 追加バージョン不明（マスタ未登録）は新曲枠の候補にしない
        current = 26500
        scores = [
            rc.ScoredChart(
                song_name="unknown", system="DX", difficulty="MASTER", level="13",
                constant=13.5, achievement=99.0, rate=300, is_ap=False,
                added_version=None, song_base_version=None,
            ),
        ]
        new_frame, best_frame = rc.select_frames(scores, current)
        self.assertEqual(len(new_frame), 0)
        self.assertEqual([c.song_name for c in best_frame], ["unknown"])

    def test_tie_break_is_deterministic(self):
        # 同点時: 定数が高い方を優先（PoC の暫定方針）し、結果が決定的
        current = 26500
        tie_rate = 300
        scores = [
            self.make("low_const", tie_rate, 26500, constant=13.0),
            self.make("high_const", tie_rate, 26500, constant=14.5),
        ] + [self.make(f"filler{i}", tie_rate + 1 + i, 26500) for i in range(14)]
        new1, _ = rc.select_frames(scores, current)
        new2, _ = rc.select_frames(list(reversed(scores)), current)
        self.assertEqual([c.song_name for c in new1], [c.song_name for c in new2])
        self.assertEqual(len(new1), 15)
        self.assertEqual(new1[-1].song_name, "high_const")  # 同点の末席は定数が高い方

    def test_tie_at_boundary_loser_goes_out(self):
        # 15 位で同点 → 1 つだけ枠入り（決定的）、負けた方は圏外（ベスト枠にも入らない）
        current = 26500
        scores = [self.make(f"top{i}", 400 + i, 26500) for i in range(14)]
        scores.append(self.make("tie_a", 300, 26500, constant=13.9))
        scores.append(self.make("tie_b", 300, 26500, constant=13.0))
        new_frame, best_frame = rc.select_frames(scores, current)
        self.assertEqual(len(new_frame), 15)
        self.assertIn("tie_a", [c.song_name for c in new_frame])
        self.assertNotIn("tie_b", [c.song_name for c in new_frame])
        self.assertNotIn("tie_b", [c.song_name for c in best_frame])


class TestCalcRating(unittest.TestCase):
    def test_sum(self):
        def chart(rate):
            return rc.ScoredChart(
                song_name="x", system="ST", difficulty="MASTER", level="13",
                constant=13.0, achievement=99.0, rate=rate, is_ap=False,
                added_version=20000, song_base_version=20000,
            )

        self.assertEqual(rc.calc_rating([chart(100), chart(200)], [chart(300)]), 600)
        self.assertEqual(rc.calc_rating([], []), 0)

    def test_typical_scale(self):
        # 定数 14.0・SSS+ 50 譜面なら 316 × 50 = 15800（AP50 込み）になる規模感
        def chart(rate):
            return rc.ScoredChart(
                song_name="x", system="ST", difficulty="MASTER", level="14",
                constant=14.0, achievement=100.5, rate=rate, is_ap=True,
                added_version=20000, song_base_version=20000,
            )

        self.assertEqual(
            rc.calc_rating([chart(316)] * 15, [chart(316)] * 35), 15800
        )


STATS_BLOCK = """538/560
CLEAR! 500/560
CLEAR 420/560
S 350/560
S+ 300/560
SS 250/560
SS+ 180/560
SSS 100/560
SSS+ 30/560
FC 120/560
FC+ 80/560
AP 40/560
AP+ 10/560
SYNC PLAY 200/560
FS 100/560
FS+ 60/560
FDX 30/560
★1 150/560
★2 120/560
★3 90/560
★4 60/560
★5 30/560"""


def make_paste(sections: list[tuple[str, list[tuple[str, str, str]]]]) -> str:
    """テスト用のコピペテキストを組み立てる。

    sections: [(LEVEL ヘッダラベル, [(レベル行, 曲名, 達成率行), ...]), ...]
    """
    parts = []
    for label, songs in sections:
        parts.append(f"LEVEL {label}")
        parts.append(STATS_BLOCK)
        for lv, name, ach in songs:
            parts.append(lv)
            parts.append(name)
            parts.append(ach)
    return "\n".join(parts) + "\n"


class TestDisplayLevelToIndex(unittest.TestCase):
    """表示 Lv → 内部 Lv インデックス変換（domain.md『スコア入力フォーマット』）。"""

    def test_examples(self):
        cases = [
            ("6", 6),
            ("7", 7),
            ("7+", 8),
            ("13", 19),  # 実測例
            ("13+", 20),
            ("14", 21),
            ("14+", 22),
            ("15", 23),  # 実測例
        ]
        for label, index in cases:
            with self.subTest(level=label):
                self.assertEqual(np.display_level_to_index(label), index)

    def test_formula(self):
        # レベル = N + max(0, N − 7)
        for n in range(1, 16):
            self.assertEqual(np.display_level_to_index(str(n)), n + max(0, n - 7))

    def test_invalid(self):
        for label in ("0", "16", "6+", "15+", "abc", "", "13++"):
            with self.subTest(level=label):
                with self.assertRaises(ValueError):
                    np.display_level_to_index(label)


class TestParsePaste(unittest.TestCase):
    """NET コピペテキストのパース。"""

    def test_basic(self):
        text = make_paste(
            [
                (
                    "13",
                    [
                        ("13", "Overdose", "99.4035%1,243 / 1,404"),
                        ("13", "Colorful Starting Line", "100.5609%2,417 / 2,664"),
                    ],
                )
            ]
        )
        result = np.parse_paste(text)
        self.assertEqual(len(result.records), 2)
        r0, r1 = result.records
        self.assertEqual(r0.song_name, "Overdose")
        self.assertEqual(r0.display_level, "13")
        self.assertEqual(r0.level_index, 19)
        self.assertAlmostEqual(r0.achievement, 99.4035)
        self.assertEqual(r0.perfect_notes, 1243)
        self.assertEqual(r0.total_notes, 1404)
        self.assertFalse(r0.is_ap_like)
        self.assertEqual(r1.song_name, "Colorful Starting Line")
        self.assertAlmostEqual(r1.achievement, 100.5609)
        self.assertTrue(r1.is_ap_like)
        self.assertEqual(result.conflicts, [])

    def test_stats_block_skipped(self):
        text = make_paste([("13", [("13", "Overdose", "99.4035%1,243 / 1,404")])])
        result = np.parse_paste(text)
        names = [r.song_name for r in result.records]
        self.assertEqual(names, ["Overdose"])  # 統計行（CLEAR! など）は曲名にならない
        for line in STATS_BLOCK.splitlines():
            self.assertTrue(np.is_stats_line(line), line)

    def test_multiple_level_sections(self):
        text = make_paste(
            [
                ("13", [("13", "Song A", "99.0000%100 / 200")]),
                ("13+", [("13+", "Song B", "98.0000%100 / 200")]),
                ("14", [("14", "Song C", "97.0000%100 / 200")]),
            ]
        )
        result = np.parse_paste(text)
        self.assertEqual([r.display_level for r in result.records], ["13", "13+", "14"])
        self.assertEqual([r.level_index for r in result.records], [19, 20, 21])
        self.assertEqual(result.level_sections, [("13", 19), ("13+", 20), ("14", 21)])

    def test_plus_level_in_triple(self):
        text = make_paste([("13+", [("13+", "Song B", "98.0000%100 / 200")])])
        result = np.parse_paste(text)
        self.assertEqual(result.records[0].display_level, "13+")
        self.assertEqual(result.records[0].level_index, 20)

    def test_numeric_song_name(self):
        # 曲名が数字だけの曲（例: '190'）でも 3 行組を正しく認識する
        text = make_paste([("14", [("14", "190", "99.5000%1,000 / 1,200")])])
        result = np.parse_paste(text)
        self.assertEqual(len(result.records), 1)
        self.assertEqual(result.records[0].song_name, "190")
        self.assertEqual(result.records[0].display_level, "14")
        self.assertEqual(result.records[0].level_index, 21)

    def test_conflict_detection(self):
        # 同一 (表示Lv, 曲名) が複数 → 衝突として検出（譜面難易度・ST/DX が判別できない）
        text = make_paste(
            [
                (
                    "13",
                    [
                        ("13", "BAD∞END∞NIGHT", "98.9999%1,000 / 1,212"),
                        ("13", "BAD∞END∞NIGHT", "100.0000%1,100 / 1,212"),
                    ],
                )
            ]
        )
        result = np.parse_paste(text)
        self.assertEqual(len(result.records), 2)  # 両方の行は保持する
        self.assertEqual(result.conflicts, [("13", "BAD∞END∞NIGHT", 2)])
        self.assertTrue(any("衝突" in w for w in result.warnings))

    def test_missing_level_line_falls_back_to_header(self):
        text = make_paste([("13", [("", "Overdose", "99.4035%1,243 / 1,404")])])
        # レベル行を空にする（3 行組の 1 行目がない形）
        result = np.parse_paste(text)
        self.assertEqual(len(result.records), 1)
        self.assertEqual(result.records[0].display_level, "13")  # ヘッダから補完
        self.assertTrue(result.warnings)

    def test_no_notes_part(self):
        text = make_paste([("13", [("13", "Overdose", "99.4035%")])])
        result = np.parse_paste(text)
        self.assertEqual(len(result.records), 1)
        self.assertIsNone(result.records[0].perfect_notes)
        self.assertIsNone(result.records[0].total_notes)

    def test_empty_and_garbage(self):
        self.assertEqual(np.parse_paste("").records, [])
        self.assertEqual(np.parse_paste("ただの文章\nだけのテキスト").records, [])
        result = np.parse_paste("LEVEL 13\n13\nBroken\nnot-a-score\n")
        self.assertEqual(result.records, [])



if __name__ == "__main__":
    unittest.main()
