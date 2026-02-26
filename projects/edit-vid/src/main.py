import os
import shutil
import subprocess
import uuid
from typing import List

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


class Subtitle(BaseModel):
    text: str
    startTime: float
    endTime: float


class ExportRequest(BaseModel):
    filename: str
    subtitles: List[Subtitle]
    fontSize: int
    fontColor: str
    boxColor: str


class SubtitlePreview(BaseModel):
    filename: str
    text: str
    startTime: float
    duration: float
    fontSize: int = 24
    fontColor: str = "white"
    boxColor: str = "black@0.5"


# ディレクトリ作成
os.makedirs("uploads", exist_ok=True)
os.makedirs("previews", exist_ok=True)
os.makedirs("exports", exist_ok=True)

app = FastAPI()

# 本番環境: ビルドされたフロントエンドを配信
# frontend/dist が存在する場合はそこから静的ファイルを配信
FRONTEND_DIST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "dist")
if os.path.isdir(FRONTEND_DIST):
    app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIST, "assets")), name="assets")


def remove_file(path: str):
    """指定されたパスのファイルを削除する"""
    try:
        os.remove(path)
        print(f"Removed temp file: {path}")
    except OSError as e:
        print(f"Error removing file {path}: {e}")


@app.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    """ビデオファイルをアップロードし、ユニークなファイル名を付けて保存する"""
    try:
        extension = os.path.splitext(str(file.filename))[1]
        unique_filename = f"{uuid.uuid4()}{extension}"
        file_path = os.path.join("uploads", unique_filename)
        with open(file_path, "wb") as buffer:
            buffer.write(await file.read())
        return JSONResponse(content={"url": f"/videos/{unique_filename}"})
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"ファイルのアップロードに失敗しました: {e}"
        )


@app.delete("/videos/{filename}")
async def delete_video(filename: str):
    """指定されたビデオファイルをサーバーから削除する"""
    try:
        uploads_dir = os.path.abspath("uploads")
        file_path = os.path.abspath(os.path.join(uploads_dir, filename))
        if not file_path.startswith(uploads_dir):
            raise HTTPException(status_code=400, detail="不正なファイルパスです。")
        if os.path.exists(file_path):
            os.remove(file_path)
            return JSONResponse(content={"status": "deleted", "filename": filename})
        else:
            raise HTTPException(status_code=404, detail="ファイルが見つかりません。")
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"ファイルの削除中にエラーが発生しました: {e}"
        )


@app.post("/export")
async def export_video(item: ExportRequest):
    """すべての字幕を焼き付けたビデオを生成する"""
    uploads_dir = os.path.abspath("uploads")
    input_path = os.path.abspath(os.path.join(uploads_dir, item.filename))

    if not input_path.startswith(uploads_dir):
        raise HTTPException(status_code=400, detail="不正なファイルパスです。")
    if not os.path.exists(input_path):
        raise HTTPException(status_code=404, detail="ビデオファイルが見つかりません。")

    exports_dir = os.path.abspath("exports")
    base, ext = os.path.splitext(item.filename)
    output_filename = f"{base}_export_{uuid.uuid4().hex[:8]}{ext}"
    output_path = os.path.join(exports_dir, output_filename)

    filters = []
    for sub in item.subtitles:
        escaped_text = (
            sub.text.replace("\\", "\\\\")
            .replace("'", "'\\''")
            .replace(":", "\\:")
            .replace(",", "\\,")
        )
        filter_str = (
            f"drawtext="
            f"fontfile=/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf:"
            f"text='{escaped_text}':"
            f"fontsize={item.fontSize}:"
            f"fontcolor={item.fontColor}:"
            f"x=(w-text_w)/2:"
            f"y=h-th-20:"
            f"box=1:boxcolor={item.boxColor}:boxborderw=10:"
            f"enable='between(t,{sub.startTime},{sub.endTime})'"
        )
        filters.append(filter_str)

    video_filter = ",".join(filters)

    command = [
        "ffmpeg",
        "-i",
        input_path,
        "-vf",
        video_filter,
        "-c:a",
        "copy",
        output_path,
        "-y",
    ]

    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
        return FileResponse(
            output_path,
            media_type="video/mp4",
            filename=f"editvid_{item.filename}",
        )
    except subprocess.CalledProcessError as e:
        error_message = e.stderr or e.stdout or "Unknown FFmpeg error"
        # エラーレスポンスを返す前に、失敗した出力ファイルを削除する
        if os.path.exists(output_path):
            os.remove(output_path)
        raise HTTPException(
            status_code=500,
            detail=f"ビデオのエクスポートに失敗しました: {error_message}",
        )
    except Exception as e:
        if os.path.exists(output_path):
            os.remove(output_path)
        raise HTTPException(
            status_code=500,
            detail=f"エクスポート中に予期せぬエラーが発生しました: {e}",
        )


@app.post("/clear-cache")
async def clear_cache():
    """uploads, exports, previewsディレクトリを再作成する"""
    errors = []
    for dir_name in ["uploads", "exports", "previews"]:
        try:
            target_dir = os.path.abspath(dir_name)
            if os.path.isdir(target_dir):
                shutil.rmtree(target_dir)
            os.makedirs(target_dir, exist_ok=True)
            # .gitkeepファイルを作成して、ディレクトリがgitに追跡されるようにする
            with open(os.path.join(target_dir, ".gitkeep"), "w") as f:
                pass
        except Exception as e:
            errors.append(f"Failed to clear directory {dir_name}: {e}")

    if errors:
        raise HTTPException(status_code=500, detail=", ".join(errors))

    return JSONResponse(content={"status": "cache cleared"})


@app.post("/preview")
async def preview_subtitle(item: SubtitlePreview, background_tasks: BackgroundTasks):
    """字幕のプレビュー画像を生成する"""
    uploads_dir = os.path.abspath("uploads")
    input_path = os.path.abspath(os.path.join(uploads_dir, item.filename))

    if not input_path.startswith(uploads_dir):
        raise HTTPException(status_code=400, detail="不正なファイルパスです。")
    if not os.path.exists(input_path):
        raise HTTPException(status_code=404, detail="ビデオファイルが見つかりません。")

    previews_dir = os.path.abspath("previews")
    output_filename = f"preview_{uuid.uuid4()}.jpg"
    output_path = os.path.join(previews_dir, output_filename)

    escaped_text = (
        item.text.replace("\\", "\\\\").replace("'", "'\\''").replace(":", "\\:")
    )

    subtitle_filter = (
        f"drawtext="
        f"fontfile=/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf:"
        f"text='{escaped_text}':"
        f"fontsize={item.fontSize}:"
        f"fontcolor={item.fontColor}:"
        f"x=(w-text_w)/2:"
        f"y=h-th-10:"
        f"box=1:boxcolor={item.boxColor}:boxborderw=5:"
        f"enable='between(t,{item.startTime},{item.startTime + item.duration})'"
    )

    command = [
        "ffmpeg",
        "-i",
        input_path,
        "-ss",
        str(item.startTime),
        "-vf",
        subtitle_filter,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        output_path,
        "-y",
    ]

    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
        background_tasks.add_task(remove_file, output_path)
        return FileResponse(output_path, media_type="image/jpeg")
    except subprocess.CalledProcessError as e:
        error_message = e.stderr or e.stdout or "Unknown FFmpeg error"
        raise HTTPException(
            status_code=500,
            detail=f"プレビューの生成に失敗しました: {error_message}",
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"プレビューの生成中に予期せぬエラーが発生しました: {e}",
        )


@app.get("/")
def read_root():
    """フロントエンドのHTMLを返す"""
    # 本番環境: ビルドされたindex.htmlを返す
    if os.path.isdir(FRONTEND_DIST):
        return FileResponse(os.path.join(FRONTEND_DIST, "index.html"))
    # 開発環境: 従来のindex.htmlを返す（互換性のため）
    return FileResponse("src/index.html")


# 静的ファイルの配信
app.mount("/videos", StaticFiles(directory="uploads"), name="videos")
app.mount("/exports", StaticFiles(directory="exports"), name="exports")
