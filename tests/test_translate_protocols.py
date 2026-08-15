from server.services.translate import build_ai_request_args


def test_build_ai_request_args_gemini() -> None:
    url, headers, payload, extract_fn = build_ai_request_args(
        api_format="Gemini",
        base_url="https://generativelanguage.googleapis.com",
        model="gemini-2.0-flash",
        api_key="test-gemini-key",
        system_prompt="sys prompt",
        user_prompt="['hello']",
    )
    assert "generativelanguage.googleapis.com" in url
    assert headers["x-goog-api-key"] == "test-gemini-key"
    assert payload["contents"][0]["parts"][0]["text"] == "['hello']"

    mock_resp = {
        "candidates": [
            {"content": {"parts": [{"text": '["你好"]'}]}}
        ]
    }
    assert extract_fn(mock_resp) == '["你好"]'


def test_build_ai_request_args_openai() -> None:
    url, headers, payload, extract_fn = build_ai_request_args(
        api_format="OpenAI",
        base_url="https://api.oneapi.com/v1",
        model="gpt-4o-mini",
        api_key="sk-test",
        system_prompt="sys prompt",
        user_prompt="['hello']",
    )
    assert url == "https://api.oneapi.com/v1/chat/completions"
    assert headers["Authorization"] == "Bearer sk-test"
    assert payload["response_format"] == {"type": "json_object"}

    mock_resp = {
        "choices": [
            {"message": {"content": '["你好"]'}}
        ]
    }
    assert extract_fn(mock_resp) == '["你好"]'


def test_build_ai_request_args_openai_response() -> None:
    url, headers, payload, extract_fn = build_ai_request_args(
        api_format="OpenAI-Response",
        base_url="https://api.openai.com",
        model="gpt-4o",
        api_key="sk-test",
        system_prompt="sys prompt",
        user_prompt="['hello']",
    )
    assert url == "https://api.openai.com/v1/responses"
    assert headers["Authorization"] == "Bearer sk-test"
    assert payload["instructions"] == "sys prompt"
    assert payload["input"] == "['hello']"

    mock_resp = {
        "output_text": '["你好"]'
    }
    assert extract_fn(mock_resp) == '["你好"]'


def test_build_ai_request_args_anthropic() -> None:
    url, headers, payload, extract_fn = build_ai_request_args(
        api_format="Anthropic",
        base_url="",
        model="claude-3-5-sonnet-20241022",
        api_key="sk-ant-test",
        system_prompt="sys prompt",
        user_prompt="['hello']",
    )
    assert url == "https://api.anthropic.com/v1/messages"
    assert headers["x-api-key"] == "sk-ant-test"
    assert payload["system"] == "sys prompt"

    mock_resp = {
        "content": [
            {"type": "text", "text": '["你好"]'}
        ]
    }
    assert extract_fn(mock_resp) == '["你好"]'


def test_adaptive_rate_limiter() -> None:
    import asyncio

    from server.services.translate import AdaptiveRateLimiter

    limiter = AdaptiveRateLimiter()
    assert limiter.current_delay == 0.0

    # 遇到 429 限流，乘性加大间隔
    asyncio.run(limiter.on_rate_limit())
    assert limiter.current_delay == 1.5

    # 再次 429，继续增大
    asyncio.run(limiter.on_rate_limit())
    assert limiter.current_delay > 3.0

    # 连续 5 次成功后，加性缩减间隔
    d_before = limiter.current_delay
    for _ in range(5):
        asyncio.run(limiter.on_success())
    assert limiter.current_delay < d_before

