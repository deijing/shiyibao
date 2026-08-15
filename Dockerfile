# syntax=docker/dockerfile:1
# 视译宝 Web 一体镜像：构建 React 控制台，再与 FastAPI + FFmpeg 打进同一容器。

FROM node:22-bookworm-slim AS frontend
WORKDIR /src/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SHIYIBAO_DATA_DIR=/data \
    SHIYIBAO_STATIC_DIR=/app/app/dist \
    SUBTITLE_FONT="Noto Sans CJK SC"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        fontconfig \
        fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/ ./server/
COPY --from=frontend /src/app/dist ./app/dist

RUN useradd --create-home --uid 1000 --shell /bin/false shiyibao \
    && mkdir -p /data \
    && chown -R shiyibao:shiyibao /data /app
USER shiyibao

EXPOSE 8000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"

CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
