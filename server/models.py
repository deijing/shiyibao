from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class TaskStage(str, Enum):
    PENDING = "pending"
    EXTRACTING_AUDIO = "extracting_audio"
    TRANSCRIBING = "transcribing"
    TRANSLATING = "translating"
    SYNTHESIZING = "synthesizing"
    MIXING = "mixing"
    COMPLETE = "complete"
    ERROR = "error"


class TaskStartRequest(BaseModel):
    gemini_api_key: str
    mimo_api_key: str = ""
    gemini_model: Optional[str] = "gemini-2.0-flash"
    voice: str = "冰糖"
    source_lang: str = "auto"
    target_lang: str = "zh"
    stream_mode: str = "streaming"
    input_file_path: Optional[str] = None
    output_dir: Optional[str] = None


class TaskStatusResponse(BaseModel):
    task_id: str
    stage: TaskStage
    progress: int = 0
    message: str = ""
    error: Optional[str] = None
    filename: Optional[str] = None
    source_lang: Optional[str] = None
    target_lang: Optional[str] = None
    voice: Optional[str] = None
    stream_mode: Optional[str] = "streaming"
    preview_ready: bool = False
    preview_url: Optional[str] = None
    preview_duration: float = 0.0
    total_chunks: int = 1
    completed_chunks: int = 0
    chunks: list[dict] = Field(default_factory=list)
    rendered_seconds: float = 0.0
    video_title: Optional[str] = None



class SubtitleSegment(BaseModel):
    index: int
    start: float
    end: float
    source_text: str
    translated_text: str = ""


class UploadResponse(BaseModel):
    task_id: str
    filename: str


class RegisterLocalRequest(BaseModel):
    input_file_path: str
    output_dir: Optional[str] = None


class ScanDirectoryRequest(BaseModel):
    input_dir: str


class ScannedVideoFile(BaseModel):
    filename: str
    path: str
    size_mb: float


class ScanDirectoryResponse(BaseModel):
    success: bool
    video_files: list[ScannedVideoFile] = []
    count: int = 0
    message: str = ""


