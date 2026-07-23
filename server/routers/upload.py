import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, File, UploadFile

from ..config import TASKS_DIR, UPLOADS_DIR
from ..models import UploadResponse

router = APIRouter()


@router.post("/upload", response_model=UploadResponse)
async def upload(file: UploadFile = File(...)) -> UploadResponse:
    task_id = str(uuid.uuid4())
    # Strip any path components a client might smuggle in the filename.
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
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    (task_dir / "task.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return UploadResponse(task_id=task_id, filename=filename)
