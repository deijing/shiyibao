import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, File, UploadFile

from ..config import TASKS_DIR, UPLOADS_DIR
from ..models import UploadResponse

router = APIRouter()


@router.post("/upload", response_model=UploadResponse)
async def upload(file: UploadFile = File(...)) -> UploadResponse:
    task_id = str(uuid.uuid4())
    # 移除客户端可能夹带在文件名中的路径组件。
    filename = Path(file.filename or "upload.mp4").name

    upload_dir = UPLOADS_DIR / task_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    dest = upload_dir / filename
    with dest.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            out.write(chunk)

    task_dir = TASKS_DIR / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "task_id": task_id,
        "filename": filename,
        "stage": "pending",
        "progress": 0,
        "message": "",
        "error": None,
        "created_at": datetime.now(UTC).isoformat(),
    }
    (task_dir / "task.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return UploadResponse(task_id=task_id, filename=filename)
