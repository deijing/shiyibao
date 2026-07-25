export interface ChangelogItem {
  version: string
  date: string
  title: string
  tag?: string
  isLatest?: boolean
  highlights: string[]
  details?: {
    features?: string[]
    improvements?: string[]
    fixes?: string[]
  }
}

export const CURRENT_VERSION = 'v0.1.3'

export const CHANGELOG_HISTORY: ChangelogItem[] = [
  {
    version: 'v0.1.3',
    date: '2026-07-25',
    title: '流式渲染稳定性与本地安全加固',
    isLatest: true,
    highlights: [
      '修复流式分片被配音轨截短，播放时间轴与最终成片时长对齐',
      '收紧本地目录扫描 / 路径注册接口，防止跨域网页读取本机视频',
      '浏览器批量模式不再误导「自动归档」，仅桌面端支持绝对路径导出',
    ],
    details: {
      features: [
        '桌面端注入本地访问令牌，保护扫目录与 register-local 接口',
        '无音轨源视频自动用静音占位混音，避免流式渲染整段失败',
      ],
      improvements: [
        'TTS 缓存改为「音色 + 文案」内容寻址，重跑任务不再复用过期配音',
        'HTTP Range 非法请求返回 416，改善视频拖拽与 Seek 兼容性',
        '分片拼接路径转义更稳健，降低 Windows / 特殊字符路径失败率',
        '后端边车端口占用时自动换端口重试，减少桌面启动失败',
        '页面与代码注释全面中文化，版本日志入口保持导航栏 / 设置 / 页脚可见',
      ],
      fixes: [
        '流式 merge_chunk 去掉 -shortest，并用 apad/atrim 补齐时间窗时长',
        '空对白时间窗静音轨按完整窗口时长生成，避免 1 秒静音截断分片',
        '浏览器无法获取输出目录绝对路径时，禁用伪归档并提示改用桌面端',
      ],
    },
  },
  {
    version: 'v0.1.2',
    date: '2026-07-25',
    title: '性能调度硬件感知与开源仓库整合',
    highlights: [
      '新增 GitHub 开源仓库导航与全站页面入口 (deijing/shiyibao)',
      '性能调度中心新增 Windows / macOS / Linux 跨平台硬件感知与动态算力自动分配算法',
      '全新设计系统版本号显示与交互式更新历史日志弹窗',
    ],
    details: {
      features: [
        '顶部导航栏、系统设置弹窗与 Footer 底部全站植入 GitHub 开源仓库地址',
        '增加全系统版本号 Badge 标记与变更日志（Changelog）弹窗页面',
      ],
      improvements: [
        '性能调度可根据 Windows (x86/ARM64) / Mac 逻辑核心数与内存大小一键智能推算推荐并发槽位',
        '优化偏好设置持久化与后端配置拉取逻辑',
      ],
      fixes: [
        '修复不同平台设备在性能调度中心显示硬编码推荐值的提示误导问题',
      ],
    },
  },
  {
    version: 'v0.1.1',
    date: '2026-07-24',
    title: '播放体验引擎与任务通知升级',
    highlights: [
      '新增“极速流式秒开”与“全量沉浸渲染”双播放引擎模式切换',
      '新增任务后台转译完成实效提示气泡与通知中心',
      '优化玻璃拟态 (Glassmorphism) UI 与深色/浅色主题对比度',
    ],
    details: {
      features: [
        '流式模式下启动 5~10 秒即刻开启秒开播放，后台增量缓冲',
        '通知中心支持未读标记、任务快速跳转与历史全量浏览',
      ],
      improvements: [
        '提升大体积视频切片合成效率',
        '改进网络异常下的任务自动重试与断点记录',
      ],
    },
  },
  {
    version: 'v0.1.0',
    date: '2026-07-20',
    title: '视译宝首个桌面与Web双端开源测试版',
    highlights: [
      '整合音频提取、BcutASR 语音识别与 Gemini 智能多语言字幕翻译',
      '整合小米 MiMo 高品质多音色语音合成',
      '支持 FFmpeg 本地音轨对齐、背景音混合与 ASS 特效字幕烧录',
    ],
    details: {
      features: [
        '支持单视频与批量视频自动化转译队列',
        '内置多音色试听与配音角色预设库',
        '支持导出 H.264 / AAC 格式 MP4 视频与 SRT/ASS 字幕文件',
      ],
    },
  },
]
