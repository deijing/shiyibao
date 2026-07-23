from enum import Enum
from typing import Optional

from pydantic import BaseModel


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


class SubtitleSegment(BaseModel):
    index: int
    start: float
    end: float
    source_text: str
    translated_text: str = ""


class UploadResponse(BaseModel):
    task_id: str
    filename: str
