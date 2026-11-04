# 内置文化传播样片

首页内置三条约 20 秒的真实视频选段。原声与预制译配 MP4、抽帧封面和台词清单位于 `app/public/samples/`，不需要用户上传、下载或在首次播放时合成。免上传载入会复制原声 MP4、提取音轨并写入校对台词，之后可以走正常的出海流程。

| 样片 | 原作者与来源 | 原片选段 | MiMo 译配 |
| --- | --- | --- | --- |
| 建盏窑变 | 匠仓，[B 站原片](https://www.bilibili.com/video/BV14R4y117so/) | 00:45.75–01:06.35，20.60 秒 | 英语 · Dean |
| 宋代点茶器具 | 学茶研习社，[B 站原片](https://www.bilibili.com/video/BV15L4y1A78K/) | 01:57.85–02:17.35，19.50 秒 | 日语 · Mia |
| 中国剪纸纹样 | 纹藏，[B 站原片](https://www.bilibili.com/video/BV1DQ4y1e7mW/) | 00:28.65–00:48.95，20.30 秒 | 韩语 · Chloe |

原片为下载的 1080p H.264 视频；内置选段输出 1280×720、H.264/AAC 与 faststart，以兼容浏览器和桌面 WebView。保留原字幕、水印和作者标识，来源链接显示在样片卡与播放器中。台词经必剪 ASR 转写，并参考原片字幕校正器具、人名等专有词。

三条样片分别采用英语、日语和韩语译配：`mimo-v2.6-flash` 生成目标语言译文，按原片发声窗口校对并精简后，由 `mimo-v2.5-tts` 使用 Dean、Mia、Chloe 音色合成。日、韩语通过清单中的 `tts_instructions` 指定朗读语言。成片按句子时间窗对齐、统一响度后封装；字幕和声音使用同一份校对译文，不表示唇形同步。

TTS 复用 `server/services/tts.py` 的接口、重试与缓存，语种朗读指令也计入缓存标识，防止更换语言后复用旧发音。预置音色和自然语言控制方式参考[小米官方说明](https://github.com/XiaomiMiMo/MiMo-Skills/blob/main/skills/mimo-v2-5-tts/SKILL.md)；本项目的日、韩语流程另经真实接口生成与播放器验证，不代表官方语种认证。

## 重建

清单 `app/public/samples/catalog.json` 记录来源、切点、封面位置、中文台词、外语译文与时间轴。先下载原片到工作目录（完整原片不进入程序资源包）：

```sh
yt-dlp --no-playlist -f 'bv*[vcodec^=avc1]+ba/b' --merge-output-format mp4 \
  --paths /tmp/shiyibao-culture-sources -o '%(id)s.%(ext)s' \
  'https://www.bilibili.com/video/BV14R4y117so/' \
  'https://www.bilibili.com/video/BV15L4y1A78K/' \
  'https://www.bilibili.com/video/BV1DQ4y1e7mW/'
```

在激活仓库 `.venv` 后，可复用已保存的应用 MiMo Key，也可通过环境变量 `MIMO_API_KEY` 提供。仅替换译配、保留原片和封面：

```sh
python scripts/prepare_culture_samples.py \
  --sources-dir /tmp/shiyibao-culture-sources \
  --dub-only --translate-with-mimo --publish-catalog
```

去掉 `--dub-only` 可从完整原片重新裁剪。`--settings-file` 可指定本机设置 JSON，`--work-dir` 指定中间文件目录，`--sample` 仅处理某一条，`--catalog` 读取待发布清单，`--list-models` 查看当前账户可用模型。使用 `--translation-model` 指定 MiMo 文本模型；未指定时默认 `mimo-v2.6-flash`。`--synthesize-only` 只生成配音缓存，不替换程序成片。

所有选中样片的云端生成完成后才开始导出。视频先写入临时文件，再原子替换；`--publish-catalog` 在全部成功后发布清单，并记录模型、音色和音频版本。后端会读取更新后的清单，译配 URL 带版本参数，避免浏览器继续播放旧音轨。API Key 不进入清单、静态资源或日志；访客试听预制 MP4 无需配置密钥。

Vite 构建会将资源复制到 `app/dist/samples`；`scripts/build_sidecar.py` 也将其嵌入后端边车，保证桌面端免上传载入可用。

## 素材使用记录

来源页面标有“未经作者授权，禁止转载”，未发现开放许可声明；本次下载与剪辑不代表取得素材授权。正式对外分发或宣传前，应向原作者及相关权利人确认剪辑、译配和内置分发的使用许可。记录来源用于溯源，不将这些片段标为本产品原创或已获官方授权。
