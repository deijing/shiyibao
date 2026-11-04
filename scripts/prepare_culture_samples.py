"""从已下载的 B 站原片重建程序内置的文化样片。

先将 catalog.json 中三个 BV 号的原片保存到 --sources-dir，再运行本脚本。
裁剪保留原音、原字幕和作者标识；复用应用的 MiMo TTS 生成预制译配。
密钥只从环境变量或本机设置读取，不写入样片清单与静态资源。
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "app" / "public" / "samples"
TRANSLATION_MODEL = "mimo-v2.6-flash"
LANGUAGE_NAMES = {"en": "English", "ja": "Japanese", "ko": "Korean", "zh": "Mandarin Chinese"}


def run(args: list[str]) -> None:
    subprocess.run(args, check=True, timeout=120)


def ffmpeg(*args: str) -> None:
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args])


def duration(path: Path) -> float:
    result = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path),
    ])
    return float(json.loads(result)["format"]["duration"])


def timestamp(value: float) -> str:
    ticks = round(value * 100)
    return f"{ticks // 360000}:{ticks // 6000 % 60:02d}:{ticks // 100 % 60:02d}.{ticks % 100:02d}"


def loudness_filter(path: Path, *, start: float = 0, length: float) -> str:
    """两遍测量并统一试听响度，防止原片与不同语种间音量突变。"""
    result = subprocess.run([
        "ffmpeg", "-hide_banner", "-ss", str(start), "-i", str(path), "-t", str(length),
        "-vn", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-",
    ], capture_output=True, text=True, check=True, timeout=30)
    data, _ = json.JSONDecoder().raw_decode(result.stderr[result.stderr.rfind("{"):])
    return (
        "loudnorm=I=-16:TP=-1.5:LRA=11:"
        f"measured_I={data['input_i']}:measured_TP={data['input_tp']}:"
        f"measured_LRA={data['input_lra']}:measured_thresh={data['input_thresh']}:"
        f"offset={data['target_offset']}:linear=true"
    )


def write_subtitles(sample: dict, path: Path) -> None:
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Dub,Arial,34,&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,1,2,1,2,70,70,130,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    for seg in sample["segments"]:
        text = seg["dubbed_text"].replace("\n", r"\N").replace("{", "").replace("}", "")
        events.append(f"Dialogue: 0,{timestamp(seg['start'])},{timestamp(seg['end'])},Dub,,0,0,0,,{text}")
    path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")


def prepare(
    sample: dict,
    sources: Path,
    work: Path,
    voices: dict[int, Path],
    *,
    dub_only: bool = False,
) -> None:
    source = sources / f"{sample['source_bvid']}.mp4"
    out = ASSETS / sample["source_file"]
    pending_source = out.with_name(f".{out.name}")
    total = sample["duration"]
    print(f"Preparing {sample['id']} ({total:.2f}s)", flush=True)
    if not dub_only:
        source_loudness = loudness_filter(source, start=sample["clip_start"], length=total)
        ffmpeg("-ss", str(sample["clip_start"]), "-i", str(source), "-t", str(total),
               "-map", "0:v:0", "-map", "0:a:0", "-vf", "scale=1280:720,setsar=1",
               "-r", "25", "-c:v", "libx264", "-preset", "fast", "-crf", "21",
               "-pix_fmt", "yuv420p", "-af", source_loudness, "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
               "-movflags", "+faststart", str(pending_source))
        pending_source.replace(out)
        ffmpeg("-ss", str(sample["poster_time"]), "-i", str(out), "-frames:v", "1",
               "-q:v", "2", str(ASSETS / Path(sample["poster"]).name))
    elif not out.is_file() or abs(duration(out) - total) > 0.1:
        raise RuntimeError(f"缺少有效原声选段：{out}")
    inputs = []
    filters = []
    labels = []
    for n, seg in enumerate(sample["segments"]):
        voice = voices.get(int(seg.get("index", n)))
        if voice is None or not voice.is_file() or voice.stat().st_size <= 100:
            raise RuntimeError(f"缺少 MiMo 配音：{sample['id']} #{n}")
        slot = seg["end"] - seg["start"]
        actual = duration(voice)
        # 只压缩超过句子窗口的语音，保留整句，不裁断词尾。
        tempo = max(1.0, actual / max(0.1, slot - 0.08))
        if tempo > 2.0:
            raise RuntimeError(f"译文过长，请缩短后重试：{sample['id']} #{n} ({tempo:.2f}x)")
        inputs.extend(["-i", str(voice)])
        filters.append(f"[{n}:a]aresample=48000,atempo={tempo:.5f},adelay={round(seg['start'] * 1000)}:all=1[a{n}]")
        labels.append(f"[a{n}]")
    filters.append(
        f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0,"
        f"asetpts=N/SR/TB,apad=whole_dur={total},atrim=end_sample={round(total * 48000)}[dub]"
    )
    wav = work / f"{sample['id']}-dub.wav"
    ffmpeg(*inputs, "-filter_complex", ";".join(filters), "-map", "[dub]",
           "-ar", "48000", "-ac", "2", "-t", str(total), "-fs", "10000000", str(wav))
    ass = work / f"{sample['id']}.ass"
    write_subtitles(sample, ass)
    dub_loudness = loudness_filter(wav, length=total)
    dubbed = ASSETS / sample["dubbed_file"]
    pending_dub = dubbed.with_name(f".{dubbed.name}")
    # 原片的中文硬字幕与署名原样保留，外语字幕放在中文上方。
    ffmpeg("-i", str(out), "-i", str(wav), "-map", "0:v:0", "-map", "1:a:0",
           "-vf", f"ass=filename='{ass}'", "-c:v", "libx264", "-preset", "fast", "-crf", "21",
           "-pix_fmt", "yuv420p", "-af", dub_loudness, "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-t", str(total),
           "-movflags", "+faststart", str(pending_dub))
    pending_dub.replace(dubbed)
    print(f"{sample['id']}: {duration(out):.2f}s", flush=True)


async def synthesize_voices(sample: dict, work: Path, api_key: str) -> dict[int, Path]:
    # 导入应用代码，确保样片与实际译制使用同一个模型、接口、重试及缓存逻辑。
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from server.services import tts

    if sample["dub_lang"] not in LANGUAGE_NAMES:
        raise ValueError(f"未知样片目标语种：{sample['dub_lang']}")
    voice = sample.get("tts_voice") or ("Dean" if sample["dub_lang"] == "en" else "茉莉")
    segments = [
        {"index": int(seg.get("index", n)), "start": seg["start"], "end": seg["end"],
         "translated_text": seg["dubbed_text"],
         **({"tts_context": sample["tts_instructions"]} if sample.get("tts_instructions") else {})}
        for n, seg in enumerate(sample["segments"])
    ]
    print(f"MiMo {tts.MIMO_MODEL} / {voice}: {sample['id']} ({len(segments)} segments)", flush=True)
    rendered = await tts.synthesize_clips(
        work / tts.MIMO_MODEL / sample["id"], segments, voice, api_key, utterances=segments,
    )
    if len(rendered) != len(segments):
        raise RuntimeError(f"MiMo 配音未完成：{sample['id']}")
    return {seg["index"]: result[2] for seg, result in zip(segments, rendered)}


async def translate_with_mimo(sample: dict, work: Path, api_key: str, model: str = TRANSLATION_MODEL) -> None:
    """严格按句对齐译文；翻译失败时终止，不能将原文当成译文继续配音。"""
    import httpx
    from server.config import MIMO_API_URL
    from server.services.translate import _extract_json_array, align_batch_translations

    language = LANGUAGE_NAMES[sample["dub_lang"]]
    timing = ("Aim for at most 2 English words per second in each time window. "
              if sample["dub_lang"] == "en" else
              "Keep each line concise enough to speak naturally within its stated seconds. "
              "Use the target language script, not romanized pronunciation or English. ")
    name_rules = (
        "Romanize 危敏捷 as Wei Minjie, 陶宝文 as Tao Baowen, 汤提点 as Tang Tidian. "
        if sample["dub_lang"] == "en" else
        "Use natural target-language cultural terms. In Japanese retain 陶宝文 and 湯提点 with brief explanations. "
        "In Korean describe Chinese paper-cutting naturally in Hangul. "
    )
    instructions = (
        f"Translate Chinese cultural documentary subtitles into concise, natural spoken {language}. "
        "Return ONLY a JSON array of objects with the original integer id and a text field. "
        "Do not merge or omit items. " + timing +
        "Preserve Jianzhan, Jianzhi and diancha only when present or directly meant in the source. "
        "Do not turn a generic black-glazed tea bowl into Jianzhan without source evidence. "
        + name_rules +
        "The tea utensil names are poetic nicknames, not people: explain the tool rather than saying gentleman. "
        "Render 浪漫 as poetic beauty or poetry, never a romantic relationship. "
        "千刻不落、万剪不断 means that after countless cuts the paper pattern remains connected; "
        "do not literally say cuts never fall or snips never break. "
        "血液 is a metaphor for keeping the tradition alive; avoid literal blood imagery. "
        "Prefer complete, idiomatic documentary narration over literal fragments. Do not add facts."
    )
    items = [{"id": seg["index"], "text": seg["source_text"],
              "seconds": round(seg["end"] - seg["start"], 2)} for seg in sample["segments"]]
    digest = hashlib.sha256(json.dumps([model, instructions, items], ensure_ascii=False).encode()).hexdigest()
    cache_dir = work / "translations"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache = cache_dir / f"{sample['id']}-{digest[:16]}.json"
    if cache.is_file():
        data = json.loads(cache.read_text(encoding="utf-8"))
    else:
        print(f"MiMo {model} translation: {sample['id']}", flush=True)
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(MIMO_API_URL,
                headers={"api-key": api_key, "Content-Type": "application/json"},
                json={"model": model, "messages": [
                    {"role": "system", "content": instructions},
                    {"role": "user", "content": json.dumps(items, ensure_ascii=False)},
                ]},
            )
            if response.is_error:
                detail = response.text.replace(api_key, "[redacted]")[:300]
                raise RuntimeError(f"MiMo 翻译接口 HTTP {response.status_code}: {detail}")
            data = _extract_json_array(response.json()["choices"][0]["message"]["content"])
    mapped = align_batch_translations(sample["segments"], data)
    if len(mapped) != len(sample["segments"]) or any(not text.strip() for text in mapped.values()):
        raise RuntimeError(f"MiMo 翻译缺少台词：{sample['id']}")
    target_script = {"ja": r"[\u3040-\u30ff]", "ko": r"[\uac00-\ud7af]"}.get(sample["dub_lang"])
    if target_script and any(not re.search(target_script, text) for text in mapped.values()):
        raise RuntimeError(f"MiMo 译文与目标语种不一致：{sample['id']} ({sample['dub_lang']})")
    for seg in sample["segments"]:
        seg["dubbed_text"] = mapped[seg["index"]]
    cache.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sample["translation_provider"] = "mimo"
    sample["translation_model"] = model


async def list_mimo_models(api_key: str) -> None:
    import httpx
    from server.config import MIMO_API_URL

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(MIMO_API_URL.rsplit("/chat/completions", 1)[0] + "/models",
                                    headers={"api-key": api_key})
        response.raise_for_status()
        print(json.dumps([item["id"] for item in response.json()["data"]]), flush=True)


def resolve_api_key(settings_file: Path | None) -> str:
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from server import config

    settings = json.loads(settings_file.read_text(encoding="utf-8")) if settings_file else config.get_user_settings()
    key = (config.MIMO_API_KEY or str(settings.get("xiaomiTtsKey") or "")).strip()
    if not key:
        raise RuntimeError("请在应用偏好设置中配置 MiMo Key，或设置 MIMO_API_KEY")
    return key


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, default=Path(tempfile.gettempdir()) / "shiyibao-sample-build")
    parser.add_argument("--catalog", type=Path, default=ASSETS / "catalog.json")
    parser.add_argument("--settings-file", type=Path)
    parser.add_argument("--sample", action="append", help="仅处理指定样片 ID，可重复")
    parser.add_argument("--synthesize-only", action="store_true", help="仅生成、缓存 MiMo 配音，不替换成片")
    parser.add_argument("--dub-only", action="store_true", help="保留已剪辑的原声选段与封面")
    parser.add_argument("--translate-with-mimo", action="store_true", help="先使用 MiMo 文本模型翻译台词")
    parser.add_argument("--publish-catalog", action="store_true", help="全部成功后更新程序的样片清单")
    parser.add_argument("--translation-model", default=TRANSLATION_MODEL)
    parser.add_argument("--list-models", action="store_true", help="列出当前 MiMo API 可用的模型 ID")
    args = parser.parse_args()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    all_samples = json.loads(args.catalog.read_text(encoding="utf-8"))
    catalog = all_samples
    if args.sample:
        unknown = set(args.sample) - {sample["id"] for sample in catalog}
        if unknown:
            parser.error(f"unknown sample: {', '.join(sorted(unknown))}")
        catalog = [sample for sample in catalog if sample["id"] in args.sample]
    api_key = resolve_api_key(args.settings_file)
    if args.list_models:
        asyncio.run(list_mimo_models(api_key))
        return
    voices_by_sample = {}
    for sample in catalog:
        if args.translate_with_mimo:
            asyncio.run(translate_with_mimo(sample, args.work_dir, api_key, args.translation_model))
        voices_by_sample[sample["id"]] = asyncio.run(synthesize_voices(sample, args.work_dir, api_key))
    if args.synthesize_only:
        return
    for sample in catalog:
        prepare(sample, args.sources_dir, args.work_dir, voices_by_sample[sample["id"]], dub_only=args.dub_only)
        sample["tts_provider"] = "mimo"
        sample["tts_model"] = "mimo-v2.5-tts"
        sample["tts_voice"] = sample.get("tts_voice") or ("Dean" if sample["dub_lang"] == "en" else "茉莉")
        sample["dub_revision"] = hashlib.sha256((ASSETS / sample["dubbed_file"]).read_bytes()).hexdigest()[:12]
        print(f"MiMo audio revision: {sample['dub_revision']}", flush=True)
    if args.publish_catalog:
        pending = ASSETS / ".catalog.json"
        pending.write_text(json.dumps(all_samples, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        pending.replace(ASSETS / "catalog.json")
        print("Published MiMo sample catalog", flush=True)


if __name__ == "__main__":
    main()
