from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


class TaskStage(StrEnum):
    PENDING = "pending"
    DOWNLOADING = "downloading"
    EXTRACTING_AUDIO = "extracting_audio"
    TRANSCRIBING = "transcribing"
    TRANSLATING = "translating"
    SYNTHESIZING = "synthesizing"
    MIXING = "mixing"
    AWAITING_REVIEW = "awaiting_review"
    COMPLETE = "complete"
    ERROR = "error"


class TaskStartRequest(BaseModel):
    gemini_api_key: str
    mimo_api_key: str = ""
    gemini_model: str | None = "gemini-2.0-flash"
    gemini_api_url: str | None = ""
    gemini_api_format: str | None = "Gemini"
    voice: str = "冰糖"
    source_lang: str = "auto"
    target_lang: str = "zh"
    stream_mode: str = "streaming"
    duration_mode: Literal["speed_audio", "slow_video", "adaptive"] = "speed_audio"
    original_audio_volume: float = Field(default=0.2, ge=0.0, le=1.0)
    input_file_path: str | None = None
    output_dir: str | None = None
    # Agent 人机协同：翻译完成后暂停，等待审核修订再继续配音合成。
    pause_after: Literal["translate"] | None = None
    # Agent 根据目标市场生成的额外翻译要求（受众、语气、保留术语等）。
    translation_instructions: str = Field(default="", max_length=4000)


class TaskStatusResponse(BaseModel):
    task_id: str
    stage: TaskStage
    progress: int = 0
    message: str = ""
    error: str | None = None
    filename: str | None = None
    source_lang: str | None = None
    target_lang: str | None = None
    voice: str | None = None
    stream_mode: str | None = "streaming"
    duration_mode: Literal["speed_audio", "slow_video", "adaptive"] = "speed_audio"
    original_audio_volume: float = 0.2
    # 成片视频只含配音，原声为单独的 original_track.m4a（播放器可实时调音量）。
    separate_original: bool = False
    original_track: bool = False
    preview_ready: bool = False
    preview_url: str | None = None
    preview_duration: float = 0.0
    total_chunks: int = 1
    completed_chunks: int = 0
    chunks: list[dict] = Field(default_factory=list)
    rendered_seconds: float = 0.0
    video_title: str | None = None
    project_folder_name: str | None = None
    project_dir: str | None = None
    campaign_id: str | None = None
    market: str | None = None



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
    output_dir: str | None = None


class FromUrlRequest(BaseModel):
    url: str = Field(..., min_length=1)


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


class AIAnalyzeRequest(BaseModel):
    mode: str = "summary"  # summary | study_notes | qa | custom
    custom_prompt: str | None = None
    gemini_api_key: str | None = None
    gemini_api_url: str | None = None
    gemini_api_format: str | None = "Gemini"
    gemini_model: str | None = "gemini-2.0-flash"


class AIAnalyzeResponse(BaseModel):
    success: bool
    analysis: str
    mode: str
    message: str | None = None



