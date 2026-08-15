"""本地 HTTP 接口的来源校验。

后端只监听 127.0.0.1，但这并不构成隔离：用户浏览器里打开的任意网页都能向
本机端口发起请求，读到 /api/settings 就等于拿到 Gemini 与 MiMo 密钥。浏览器
无法伪造 Origin 与 Referer，因此这里以「精确主机名白名单」为主要防线，并把
Tauri 注入的一次性 token 作为额外条件。

主机名必须完整匹配。曾经的前缀匹配写法会把 localhost.attacker.com 判定为
本地来源。
"""

from __future__ import annotations

import hmac
import os
from urllib.parse import urlsplit

LOCAL_TOKEN_HEADER = "x-shiyibao-local-token"

# 允许访问本地 API 的界面主机名。
LOCAL_UI_HOSTS = frozenset({"127.0.0.1", "::1", "localhost", "tauri.localhost"})

# 桌面 WebView 与 Vite 开发服务器使用的 Origin。放开任意本地端口，
# 因为 5173 被占用时 Vite 会自动改用别的端口。
CORS_ORIGIN_REGEX = (
    r"^(?:https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?"
    r"|https?://tauri\.localhost"
    r"|tauri://localhost)$"
)

# 无需来源校验的路径。Tauri 外壳和打包冒烟脚本要在注入 token 之前探测后端
# 是否就绪，因此 /api/health 必须保持开放；它只返回 FFmpeg 路径与数据目录。
# /api/shutdown 自带 shutdown token 校验。
PUBLIC_API_PATHS = frozenset({"/api/health", "/api/shutdown"})


def origin_host(value: str | None) -> str | None:
    """返回 Origin/Referer 的主机名；无法解析时返回 None。"""
    candidate = (value or "").strip()
    if not candidate:
        return None
    parts = urlsplit(candidate)
    if not parts.scheme:
        return None
    try:
        host = parts.hostname
    except ValueError:
        return None
    return host.lower() if host else None


def is_local_ui_origin(value: str | None) -> bool:
    """判断来源是否为本机界面；仅比对完整主机名，不做前缀匹配。"""
    host = origin_host(value)
    return host is not None and host in LOCAL_UI_HOSTS


def local_token_matches(provided_token: str | None) -> bool:
    """比对 Tauri 通过 SHIYIBAO_LOCAL_TOKEN 注入的一次性 token。"""
    expected = os.getenv("SHIYIBAO_LOCAL_TOKEN", "").strip()
    provided = (provided_token or "").strip()
    return bool(expected and provided and hmac.compare_digest(provided, expected))


def request_source_is_trusted(
    *,
    local_token: str | None = None,
    origin: str | None = None,
    referer: str | None = None,
    sec_fetch_site: str | None = None,
) -> bool:
    """判断一个 /api 请求是否来自可信来源。

    - token 匹配即可信（桌面端注入）。
    - ``Sec-Fetch-Site: cross-site`` 一律拒绝：浏览器强制设置该头，脚本无法伪造，
      可挡住 Origin/Referer 缺失时的跨站 CSRF。
    - Origin 或 Referer 存在时以主机名白名单为准；浏览器强制设置这两个头，
      网页脚本无法覆盖，因此这条足以挡住跨站读取。
    - 两者都不存在时视为本机脚本/CLI 调用，或是 no-referrer 的媒体标签请求。
      服务仅监听回环地址，放行。
    """
    if local_token_matches(local_token):
        return True
    if (sec_fetch_site or "").strip().lower() == "cross-site":
        return False
    for value in (origin, referer):
        if (value or "").strip():
            return is_local_ui_origin(value)
    return True
