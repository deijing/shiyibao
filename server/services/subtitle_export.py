"""字幕下载序列化；单语模式严格使用所选语言，不回退到另一种语言。"""
import json
from typing import Literal

SubtitleContent = Literal["translated", "source", "bilingual"]
SubtitleFormat = Literal["srt", "vtt", "txt", "json"]


def _timestamp(seconds: float, separator: str) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, ms = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{separator}{ms:03d}"


def serialize_subtitles(segments: list[dict], fmt: SubtitleFormat, content: SubtitleContent) -> str:
    selected = []
    for segment in segments:
        source = str(segment.get("source_text") or "").strip()
        translated = str(segment.get("translated_text") or "").strip()
        fields = {}
        if content != "source":
            fields["translated_text"] = translated
        if content != "translated":
            fields["source_text"] = source
        lines = list(dict.fromkeys(text for text in fields.values() if text))
        if not lines:
            continue
        selected.append(({key: segment[key] for key in ("index", "start", "end")}, fields, "\n".join(lines)))
    if fmt == "json":
        return json.dumps([{**timing, **fields} for timing, fields, _ in selected], ensure_ascii=False, indent=2)
    blocks = []
    for number, (timing, _, text) in enumerate(selected, 1):
        if fmt == "txt":
            blocks.append(f"[{_timestamp(timing['start'], '.').split('.')[0]}] {text}")
        else:
            separator = "," if fmt == "srt" else "."
            blocks.append(f"{number}\n{_timestamp(timing['start'], separator)} --> "
                          f"{_timestamp(timing['end'], separator)}\n{text}\n")
    return ("WEBVTT\n\n" if fmt == "vtt" else "") + ("\n".join(blocks))
