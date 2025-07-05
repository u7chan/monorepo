import os
import subprocess
import uuid

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


class SubtitlePreview(BaseModel):
    filename: str
    text: str
    startTime: float
    duration: float


# 'uploads' ディレクトリがなければ作成する
os.makedirs("uploads", exist_ok=True)
os.makedirs("previews", exist_ok=True)

app = FastAPI()


def remove_file(path: str):
    """指定されたパスのファイルを削除する"""
    try:
        os.remove(path)
        print(f"Removed preview file: {path}")
    except OSError as e:
        print(f"Error removing file {path}: {e}")


@app.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    """ビデオファイルをアップロードし、ユニークなファイル名を付けて保存する"""
    try:
        # 安全なファイル名を生成
        extension = os.path.splitext(str(file.filename))[1]
        unique_filename = f"{uuid.uuid4()}{extension}"
        file_path = os.path.join("uploads", unique_filename)

        # ファイルを保存
        with open(file_path, "wb") as buffer:
            buffer.write(await file.read())

        # アクセス用のURLを返す
        return JSONResponse(content={"url": f"/videos/{unique_filename}"})
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"ファイルのアップロードに失敗しました: {e}"
        )


@app.delete("/videos/{filename}")
async def delete_video(filename: str):
    """指定されたビデオファイルをサーバーから削除する"""
    try:
        # セキュリティ: パストラバーサル攻撃を防ぐ
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

    # FFmpegコマンドの構築
    # テキストをエスケープして、FFmpegのフィルタ内で安全に使えるようにする
    escaped_text = (
        item.text.replace("\\", "\\\\")
        .replace("'", "'\\\''")
        .replace(":", "\\:")
    )

    # 字幕フィルタ
    subtitle_filter = (
        f"drawtext="
        f"fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:"
        f"text='{escaped_text}':"
        f"fontsize=24:"
        f"fontcolor=white:"
        f"x=(w-text_w)/2:"
        f"y=h-th-10:"
        f"box=1:boxcolor=black@0.5:boxborderw=5:"
        f"enable='between(t,{item.startTime},{item.startTime + item.duration})'"
    )

    # FFmpegコマンド
    command = [
        "ffmpeg",
        "-i",
        input_path,
        "-ss",
        str(item.startTime),  # 字幕が表示される瞬間にシーク
        "-vf",
        subtitle_filter,
        "-frames:v",
        "1",  # 1フレームだけをキャプチャ
        "-q:v",
        "2",  # 高品質なJPEG
        output_path,
        "-y",  # 既存のファイルを上書き
    ]

    try:
        # FFmpegコマンドを実行
        subprocess.run(command, check=True, capture_output=True, text=True)
        # ファイル削除をバックグラウンドタスクとして追加
        background_tasks.add_task(remove_file, output_path)
        return FileResponse(output_path, media_type="image/jpeg")
    except subprocess.CalledProcessError as e:
        # FFmpegの実行でエラーが発生した場合
        error_message = e.stderr or e.stdout or "Unknown FFmpeg error"
        raise HTTPException(
            status_code=500,
            detail=f"プレビューの生成に失敗しました: {error_message}",
        )
    except Exception as e:
        # その他の予期せぬエラー
        raise HTTPException(
            status_code=500,
            detail=f"プレビューの生成中に予期せぬエラーが発生しました: {e}",
        )


@app.get("/")
def read_root():
    """フロントエンドのHTMLを返す"""
    return FileResponse("src/index.html")


# 静的ファイルの配信
app.mount("/videos", StaticFiles(directory="uploads"), name="videos")

