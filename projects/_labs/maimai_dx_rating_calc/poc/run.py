#!/usr/bin/env python3
"""maimai でらっくす RATING 計算 PoC の実行スクリプト。

データフロー:
    公式楽曲マスタ JSON（/tmp キャッシュ or 公式 URL から取得）
        + NET コピペテキストファイル
        + constants.json（検証用譜面定数）
    → パース → 定数照合 → 単曲レート値 → 枠選定 → CSV 2 本出力

使い方:
    python3 poc/run.py <コピペファイル> <出力先ディレクトリ>
    python3 poc/run.py poc/example_paste.txt out/

出力:
    <出力先>/rating_detail.csv   曲ごとの単曲レート値と枠
    <出力先>/rating_summary.csv  RATING 値と内訳
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.request

try:
    from . import rating_core as rc
    from . import net_parser as np
except ImportError:  # スクリプト直接実行（python3 poc/run.py ...）のとき
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import net_parser as np
    import rating_core as rc

DEFAULT_MASTER_URL = "https://maimai.sega.jp/data/maimai_songs.json"
DEFAULT_MASTER_CACHE = "/tmp/maimai_songs.json"
DEFAULT_CONSTANTS_FILENAME = "constants.json"

# 公式マスタの譜面キー → 譜面難易度（domain.md『譜面の 2 系統』）
_DIFFICULTY_KEYS = (
    ("BASIC", "bas"),
    ("ADVANCED", "adv"),
    ("EXPERT", "exp"),
    ("MASTER", "mas"),
    ("Re:MASTER", "remas"),
)
_SYSTEM_PREFIXES = (("ST", "lev_"), ("DX", "dx_lev_"))

DETAIL_COLUMNS = [
    "曲名", "譜面系統", "譜面難易度", "表示Lv", "達成率", "定数", "係数",
    "単曲レート", "枠", "APフラグ",
]
SUMMARY_COLUMNS = [
    "RATING値", "新曲枠合計", "ベスト枠合計", "APボーナス数", "対象譜面数", "使用バージョン",
]

FRAME_NEW = "新曲"
FRAME_BEST = "ベスト"
FRAME_OUT = "圏外"
FRAME_CONFLICT = "未確定(衝突)"
FRAME_UNRESOLVED = "未解決(定数なし)"


# ---------------------------------------------------------------------------
# 公式楽曲マスタ JSON の読み込み
# ---------------------------------------------------------------------------

def load_master(source: str | None = None) -> tuple[list[dict], str]:
    """公式マスタ JSON を読み込み (楽曲リスト, 取得元の説明) を返す。

    優先順位: 明示指定 > キャッシュ (/tmp/maimai_songs.json) > 公式 URL から取得。
    取得に成功したらキャッシュに保存して再取得を避ける（公式側の負荷に配慮）。
    """
    if source:
        with open(source, "rb") as fh:
            return json.loads(fh.read().decode("utf-8")), f"file: {source}"

    if os.path.isfile(DEFAULT_MASTER_CACHE):
        with open(DEFAULT_MASTER_CACHE, "rb") as fh:
            return json.loads(fh.read().decode("utf-8")), f"cache: {DEFAULT_MASTER_CACHE}"

    data = _download_master(DEFAULT_MASTER_URL)
    with open(DEFAULT_MASTER_CACHE, "wb") as fh:
        fh.write(data)
    return json.loads(data.decode("utf-8")), f"download: {DEFAULT_MASTER_URL}"


def _download_master(url: str) -> bytes:
    """公式 URL からマスタ JSON を取得する。

    通常の取得 → TLS 検証を無効化した取得 → curl -k の順で試す
    （検証環境によっては証明書検証が失敗するため。最終手段は curl -k に相当）。
    """
    headers = {"User-Agent": "maimai-dx-rating-poc/0.1 (+local PoC tool)"}
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read()
    except (urllib.error.URLError, ssl.SSLError, OSError) as exc:
        first_error = exc

    try:  # TLS 検証を無効化して再試行（curl -k 相当）
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
            return resp.read()
    except (urllib.error.URLError, ssl.SSLError, OSError):
        pass

    try:  # curl -k が使える環境ならそれに委ねる
        proc = subprocess.run(
            ["curl", "-kfsSL", "--max-time", "120", url],
            capture_output=True, check=True,
        )
        if proc.stdout:
            return proc.stdout
    except (OSError, subprocess.CalledProcessError):
        pass

    raise RuntimeError(
        f"failed to download master JSON from {url} "
        f"(first error: {first_error}). "
        f"Please fetch manually, e.g. `curl -k -o {DEFAULT_MASTER_CACHE} {url}`"
    )


def build_master_index(songs: list[dict]) -> dict[tuple[str, str, str], dict]:
    """公式マスタから (曲名, 系統, 譜面難易度) → 譜面情報 の索引を作る。

    - version は「ST 譜面（BASIC〜MASTER）の追加バージョン。ST を持たない曲は
      DX 譜面の追加バージョン」という公式マスタの意味論に従う
      （domain.md『version フィールドの意味（確定）』）
    - 宴譜面（lev_utage のみのエントリ）は通常の譜面キーを持たないため自然に除外される
    """
    index: dict[tuple[str, str, str], dict] = {}
    for song in songs:
        title = song.get("title", "")
        version_raw = str(song.get("version", ""))
        if not title or not version_raw.isdigit():
            continue
        version = int(version_raw)
        for system, prefix in _SYSTEM_PREFIXES:
            for difficulty, suffix in _DIFFICULTY_KEYS:
                key = f"{prefix}{suffix}"
                if key in song:
                    entry = index.setdefault(
                        (title, system, difficulty),
                        {"song": title, "system": system, "difficulty": difficulty,
                         "level": song[key], "version": version,
                         # ウィンドウ判定用の帯（例: 26012 → 26000 = CiRCLE）
                         "version_floor": rc.version_floor(version)},
                    )
                    # 同一キーが複数曲ある場合（曲名重複）は最初の 1 件を採用し、
                    # 重複フラグを持たせる（domain.md『注意・データギャップ』）
                    entry.setdefault("duplicate_titles", []).append(version)
    return index


# ---------------------------------------------------------------------------
# 定数 DB（検証用 JSON）
# ---------------------------------------------------------------------------

def load_constants(path: str) -> list[dict]:
    """constants.json を読み込み、スキーマの基本検証を行う。"""
    with open(path, "rb") as fh:
        data = json.loads(fh.read().decode("utf-8"))
    entries = data.get("charts")
    if not isinstance(entries, list):
        raise ValueError(f"{path}: 'charts' array is missing")
    seen: set[tuple[str, str, str]] = set()
    validated: list[dict] = []
    for i, entry in enumerate(entries):
        try:
            song = str(entry["song"])
            system = str(entry["system"])
            difficulty = str(entry["difficulty"])
            level = str(entry["level"])
            constant = float(entry["constant"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"{path}: charts[{i}] is invalid: {entry!r} ({exc})") from exc
        if system not in ("ST", "DX"):
            raise ValueError(f"{path}: charts[{i}].system must be ST or DX: {system!r}")
        if difficulty not in dict(_DIFFICULTY_KEYS):
            raise ValueError(f"{path}: charts[{i}].difficulty is unknown: {difficulty!r}")
        np.display_level_to_index(level)  # 表示Lv として妥当か
        try:
            rc.single_rate(constant, 50.0)  # 定数の桁数・非負の検証を兼ねる
        except ValueError as exc:
            raise ValueError(f"{path}: charts[{i}].constant: {exc}") from exc
        key = (song, system, difficulty)
        if key in seen:
            raise ValueError(f"{path}: duplicate chart entry: {key}")
        seen.add(key)
        validated.append({
            "song": song, "system": system, "difficulty": difficulty,
            "level": level, "constant": constant, "note": entry.get("note"),
        })
    return validated


# ---------------------------------------------------------------------------
# 照合と計算
# ---------------------------------------------------------------------------

def resolve_scores(
    parsed: np.ParseResult,
    constants: list[dict],
) -> tuple[list[tuple[np.ScoreRecord, dict]], list[np.ScoreRecord], list[tuple[np.ScoreRecord, list[dict]]]]:
    """パース済みスコアを定数 DB の譜面に 1:1 で対応付ける。

    戻り値: (確定リスト, 定数が無く未解決のスコア, 衝突で確定できないスコア)

    衝突になるのは次の 2 種類（domain.md『既知の課題』『正規化 CSV』）:
    - 同一 (表示Lv, 曲名) に複数の定数エントリがある（例: ST と DX が同 Lv）
    - 同一 (表示Lv, 曲名) のスコア行がコピペ内に複数ある
      （例: MASTER と Re:MASTER が同 Lv で別行に並ぶ）
    コピペだけではどちらの譜面のスコアか確定できないため、RATING 計算から除外して報告する。
    """
    const_index: dict[tuple[str, str], list[dict]] = {}
    for entry in constants:
        const_index.setdefault((entry["song"], entry["level"]), []).append(entry)

    paste_counts: dict[tuple[str, str], int] = {}
    for record in parsed.records:
        key = (record.display_level, record.song_name)
        paste_counts[key] = paste_counts.get(key, 0) + 1

    resolved: list[tuple[np.ScoreRecord, dict]] = []
    unresolved: list[np.ScoreRecord] = []
    conflicted: list[tuple[np.ScoreRecord, list[dict]]] = []
    for record in parsed.records:
        candidates = const_index.get((record.song_name, record.display_level), [])
        if not candidates:
            unresolved.append(record)
        elif len(candidates) > 1 or paste_counts[(record.display_level, record.song_name)] > 1:
            conflicted.append((record, candidates))
        else:
            resolved.append((record, candidates[0]))
    return resolved, unresolved, conflicted


def to_scored_chart(record: np.ScoreRecord, entry: dict, master_index: dict) -> tuple[rc.ScoredChart, bool]:
    """(スコア, 定数エントリ) を単曲レート値計算済みの ScoredChart にする。

    戻り値: (ScoredChart, マスタ登録有無)
    - マスタ未登録の譜面は追加バージョン不明として扱い、新曲枠の候補にしない
    - マスタの version は系統・譜面難易度によらず曲単位の値のため、
      added_version と song_base_version（B〜M 追加バージョンの代理）は同じ値になる。
      この近似により『Re:MASTER の例外』がマスタデータからは発動しないが、
      現行ウィンドウでは Re:M の後から追加の例が無いため影響しない
      （domain.md『Re:MASTER の例外』参照。ロジック自体は rating_core が保持）
    """
    rate = rc.single_rate(entry["constant"], record.achievement)
    is_ap = record.achievement >= 100.0
    master = master_index.get((entry["song"], entry["system"], entry["difficulty"]))
    # 枠判定には version コードの帯（フロア判定値）を使う
    added_version = master["version_floor"] if master else None
    chart = rc.ScoredChart(
        song_name=entry["song"],
        system=entry["system"],
        difficulty=entry["difficulty"],
        level=entry["level"],
        constant=entry["constant"],
        achievement=record.achievement,
        rate=rate,
        is_ap=is_ap,
        added_version=added_version,
        song_base_version=added_version,
    )
    return chart, master is not None


def run_pipeline(
    paste_text: str,
    constants_path: str,
    master_source: str | None = None,
    current_version: str = rc.CURRENT_VERSION_NAME,
    log=None,
) -> dict:
    """コピペテキスト → RATING 計算までの全体フローを実行して結果を返す。"""
    if log is None:
        def log(_message: str) -> None:
            pass

    songs, master_desc = load_master(master_source)
    master_index = build_master_index(songs)
    current_code = rc.version_code_from(current_version)
    prev_code = rc.previous_version_code(current_code)

    constants = load_constants(constants_path)
    parsed = np.parse_paste(paste_text)
    for warning in parsed.warnings:
        log(f"[警告] パース: {warning}")

    resolved, unresolved, conflicted = resolve_scores(parsed, constants)

    scored: list[rc.ScoredChart] = []
    master_missing: list[str] = []
    for record, entry in resolved:
        chart, in_master = to_scored_chart(record, entry, master_index)
        scored.append(chart)
        if not in_master:
            master_missing.append(f"{entry['song']} ({entry['system']} {entry['difficulty']})")
            log(f"[警告] マスタ未登録: {master_missing[-1]} → 新曲枠の候補にしない")
        else:
            master = master_index[(entry["song"], entry["system"], entry["difficulty"])]
            if master["level"] != entry["level"]:
                log(
                    f"[警告] 表示Lv不整合: {entry['song']} ({entry['system']} {entry['difficulty']})"
                    f" 定数DB={entry['level']} マスタ={master['level']}"
                )

    new_frame, best_frame = rc.select_frames(scored, current_code)
    selected_ids = {id(c) for c in new_frame + best_frame}
    out_of_frame = sorted(
        (c for c in scored if id(c) not in selected_ids),
        key=lambda c: (-c.rate, c.song_name),
    )

    new_sum = sum(c.rate for c in new_frame)
    best_sum = sum(c.rate for c in best_frame)
    ap_count = sum(1 for c in new_frame + best_frame if c.is_ap)

    return {
        "master_desc": master_desc,
        "master_song_count": len(songs),
        "parsed": parsed,
        "current_code": current_code,
        "current_name": rc.version_name(current_code),
        "prev_code": prev_code,
        "prev_name": rc.version_name(prev_code),
        "scored": scored,
        "new_frame": new_frame,
        "best_frame": best_frame,
        "out_of_frame": out_of_frame,
        "unresolved": unresolved,
        "conflicted": conflicted,
        "master_missing": master_missing,
        "rating": rc.calc_rating(new_frame, best_frame),
        "new_sum": new_sum,
        "best_sum": best_sum,
        "ap_count": ap_count,
    }


# ---------------------------------------------------------------------------
# CSV 出力
# ---------------------------------------------------------------------------

def _format_float(value: float) -> str:
    """定数・係数はいずれも小数第 1 位までのため、'20.0' のように 1 桁で出す。"""
    return f"{value:.1f}"


def _detail_row(chart: rc.ScoredChart, frame: str) -> list[str]:
    return [
        chart.song_name,
        chart.system,
        chart.difficulty,
        chart.level,
        f"{chart.achievement:.4f}",
        _format_float(chart.constant),
        _format_float(rc.rank_coefficient(chart.achievement)),
        str(chart.rate),
        frame,
        "true" if chart.is_ap else "false",
    ]


def build_detail_rows(result: dict) -> list[list[str]]:
    """rating_detail.csv の全行（ヘッダ以外）を組み立てる。"""
    rows: list[list[str]] = []
    for chart in result["new_frame"]:
        rows.append(_detail_row(chart, FRAME_NEW))
    for chart in result["best_frame"]:
        rows.append(_detail_row(chart, FRAME_BEST))
    for chart in result["out_of_frame"]:
        rows.append(_detail_row(chart, FRAME_OUT))
    parsed = result["parsed"]
    for record, _candidates in result["conflicted"]:
        rows.append([
            record.song_name, "", "", record.display_level,
            f"{record.achievement:.4f}", "", "", "",
            FRAME_CONFLICT,
            "true" if record.is_ap_like else "false",
        ])
    for record in result["unresolved"]:
        rows.append([
            record.song_name, "", "", record.display_level,
            f"{record.achievement:.4f}", "", "", "",
            FRAME_UNRESOLVED,
            "true" if record.is_ap_like else "false",
        ])
    return rows


def write_csvs(result: dict, output_dir: str) -> tuple[str, str]:
    """rating_detail.csv と rating_summary.csv を出力ディレクトリへ書く。"""
    os.makedirs(output_dir, exist_ok=True)
    detail_path = os.path.join(output_dir, "rating_detail.csv")
    summary_path = os.path.join(output_dir, "rating_summary.csv")

    # Excel で開けるよう UTF-8 (BOM 付き) で出力する
    with open(detail_path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(DETAIL_COLUMNS)
        writer.writerows(build_detail_rows(result))

    version_label = (
        f"{result['current_name']} ({result['current_code']})"
        f" / {result['prev_name']} ({result['prev_code']})"
    )
    with open(summary_path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(SUMMARY_COLUMNS)
        writer.writerow([
            result["rating"],
            result["new_sum"],
            result["best_sum"],
            result["ap_count"],
            len(result["new_frame"]) + len(result["best_frame"]),
            version_label,
        ])
    return detail_path, summary_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="maimai でらっくす RATING 計算 PoC（NET コピペ + 検証用定数 → CSV）"
    )
    parser.add_argument("paste_file", help="NET からコピーしたテキストファイル")
    parser.add_argument("output_dir", help="CSV の出力先ディレクトリ")
    parser.add_argument(
        "--master", default=None,
        help=f"公式マスタ JSON のパスまたは URL（既定: {DEFAULT_MASTER_CACHE} があれば使用、"
             f"なければ {DEFAULT_MASTER_URL} から取得）",
    )
    parser.add_argument(
        "--constants", default=None,
        help="譜面定数 JSON（既定: スクリプト同梱の constants.json）",
    )
    parser.add_argument(
        "--current-version", default=rc.CURRENT_VERSION_NAME,
        help=f"現行バージョンの名前または基準コード（既定: {rc.CURRENT_VERSION_NAME}）",
    )
    args = parser.parse_args(argv)

    constants_path = args.constants or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), DEFAULT_CONSTANTS_FILENAME
    )

    try:
        with open(args.paste_file, "rb") as fh:
            paste_text = fh.read().decode("utf-8", errors="replace")
    except OSError as exc:
        print(f"ERROR: cannot read paste file: {exc}", file=sys.stderr)
        return 2

    def log(message: str) -> None:
        print(message, file=sys.stderr)

    try:
        result = run_pipeline(
            paste_text,
            constants_path,
            master_source=args.master,
            current_version=args.current_version,
            log=log,
        )
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if not result["parsed"].records:
        print("ERROR: no score rows were parsed from the paste file.", file=sys.stderr)
        return 1
    if not result["scored"]:
        print("ERROR: no scores could be matched to the constants DB.", file=sys.stderr)
        return 1

    detail_path, summary_path = write_csvs(result, args.output_dir)

    print(f"マスタ: {result['master_desc']}（{result['master_song_count']} 曲）")
    print(f"バージョンウィンドウ: {result['current_name']} ({result['current_code']})"
          f" + {result['prev_name']} ({result['prev_code']})")
    print(f"RATING: {result['rating']}")
    print(f"  新曲枠: {result['new_sum']}（{len(result['new_frame'])} 譜面 / 上限 {rc.NEW_FRAME_SIZE}）")
    print(f"  ベスト枠: {result['best_sum']}（{len(result['best_frame'])} 譜面 / 上限 {rc.BEST_FRAME_SIZE}）")
    print(f"  AP ボーナス: {result['ap_count']}")
    print(f"  対象譜面数: {len(result['new_frame']) + len(result['best_frame'])}")
    if result["conflicted"]:
        names = ", ".join(f"{r.song_name}(Lv{r.display_level})" for r, _c in result["conflicted"])
        print(f"衝突（RATING 未反映）: {names}", file=sys.stderr)
    if result["unresolved"]:
        names = ", ".join(f"{r.song_name}(Lv{r.display_level})" for r in result["unresolved"])
        print(f"定数未登録（RATING 未反映）: {names}", file=sys.stderr)
    print(f"出力: {detail_path}")
    print(f"出力: {summary_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
