import asyncio
import pytest
from server.services.language_detector import rule_based_detect_language, detect_language_from_text


def test_rule_based_chinese():
    code, name = rule_based_detect_language("你好，这是一个测试视频，包含中文对白。")
    assert code == "zh"
    assert name == "中文"


def test_rule_based_english():
    code, name = rule_based_detect_language("Hello everyone, welcome to our channel. Today we are discussing AI video translation.")
    assert code == "en"
    assert name == "英语"


def test_rule_based_japanese():
    code, name = rule_based_detect_language("こんにちは！本日の動画では最新のAI技術について解説します。")
    assert code == "ja"
    assert name == "日语"


def test_rule_based_korean():
    code, name = rule_based_detect_language("안녕하세요! 오늘 영상에서는 최신 AI 기술에 대해 알아보겠습니다.")
    assert code == "ko"
    assert name == "韩语"


def test_rule_based_french():
    code, name = rule_based_detect_language("Bonjour tout le monde, bienvenue dans cette vidéo sur la traduction automatique.")
    assert code == "fr"
    assert name == "法语"


def test_rule_based_german():
    code, name = rule_based_detect_language("Guten Tag und herzlich willkommen zu diesem Video über künstliche Intelligenz.")
    assert code == "de"
    assert name == "德语"


def test_rule_based_spanish():
    code, name = rule_based_detect_language("Hola a todos, bienvenidos a este video sobre inteligencia artificial y traducción.")
    assert code == "es"
    assert name == "西班牙语"


def test_rule_based_russian():
    code, name = rule_based_detect_language("Всем привет, добро пожаловать на наш канал о технологиях искусственного интеллекта.")
    assert code == "ru"
    assert name == "俄语"


def test_detect_language_from_text_segments():
    segments = [
        {"source_text": "Hello world!"},
        {"source_text": "This is an automated test for audio language detection."},
    ]
    code, name = asyncio.run(detect_language_from_text(segments))
    assert code == "en"
    assert name == "英语"
