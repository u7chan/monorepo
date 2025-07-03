import os
import uuid

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# 'uploads' ディレクトリがなければ作成する
os.makedirs("uploads", exist_ok=True)

app = FastAPI()


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


@app.get("/")
def read_root():
    """フロントエンドのHTMLを返す"""
    return FileResponse("index.html")


# すべてのAPIルートを定義した後に `mount` を記述する
# これにより、GET /videos/{filename} が静的ファイルとして扱われ、
# DELETE /videos/{filename} は上記のAPIエンドポイントで処理されるようになります。
app.mount("/videos", StaticFiles(directory="uploads"), name="videos")
