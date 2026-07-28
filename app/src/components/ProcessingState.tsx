import { useEffect, useState, useRef, useCallback } from 'react'
import {
  Layers,
  Languages,
  Mic,
  Check,
  Bot,
  AlertCircle,
  Terminal,
  Radio,
  Copy,
  Sparkles,
  Volume2,
  Maximize2,
  Loader2,
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react'
import { getTaskStatus, getTaskLogs, getSubtitles, type TaskStatus, type TaskLogItem, type SubtitleSegment } from '@/lib/api'
import { clearActiveTaskId } from '@/lib/task-session'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import TaskDetailDrawer from './TaskDetailDrawer'
import TencentStreamPlayer from './TencentStreamPlayer'
import { loadSettings, getGeminiModelDisplayName, getLanguageDisplayName, type AppSettings } from './SettingsPanel'

interface ProcessingStateProps {
  taskId: string
  onComplete: () => void
  onNavigateToHistory?: () => void
}

type ProcessingStepIndex = 1 | 2 | 3

const STAGE_ORDER = ['extracting_audio', 'transcribing', 'translating', 'synthesizing', 'mixing', 'complete'] as const

function stageToStepNumber(stage: TaskStatus['stage']): ProcessingStepIndex {
  if (stage === 'extracting_audio' || stage === 'pending') return 1
  if (stage === 'transcribing' || stage === 'translating') return 2
  return 3
}

function stageToCardState(stage: TaskStatus['stage']) {
  const idx = STAGE_ORDER.indexOf(stage as typeof STAGE_ORDER[number])
  return {
    step1Done: idx >= 1,
    step2Done: idx >= 3,
    step3Done: idx >= 4,
    allDone: stage === 'complete',
  }
}

function stageLabel(stage: TaskStatus['stage']): string {
  const labels: Record<string, string> = {
    pending: '初始化核心引擎...',
    extracting_audio: '步骤 1/3: 正在提取 PCM 音频轨...',
    transcribing: '步骤 2/3: 必剪 ASR 智能对白断句...',
    translating: '步骤 2/3: Gemini 大模型双语润色与翻译...',
    synthesizing: '步骤 3/3: MiMo 音色克隆与声学合成...',
    mixing: '步骤 3/3: FFmpeg 多轨混音与导出成片...',
    complete: '🎉 全部流程处理完成！',
    error: '⚠️ 处理遇到错误',
  }
  return labels[stage] ?? stage
}

interface ParsedTtsLog {
  current: number
  total: number
  subRange: string
  text: string
  percent: number
}

function parseTtsLogMessage(msg: string): ParsedTtsLog | null {
  if (!msg) return null
  const match = msg.match(/语义段\s*\[(\d+)\/(\d+)\](?:\s*\(原字幕\s*([\d-]+)\))?\s*(?:"([^"]+)"|'([^']+)')?/)
  if (match) {
    const current = parseInt(match[1], 10)
    const total = parseInt(match[2], 10)
    const subRange = match[3] || ''
    const text = match[4] || match[5] || ''
    const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0
    return { current, total, subRange, text, percent }
  }
  return null
}

export default function ProcessingState({ taskId, onComplete, onNavigateToHistory }: ProcessingStateProps) {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [status, setStatus] = useState<TaskStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<TaskLogItem[]>([])
  const [subtitles, setSubtitles] = useState<SubtitleSegment[]>([])

  useEffect(() => {
    function syncSettings() {
      setSettings(loadSettings())
    }
    window.addEventListener('settings-updated', syncSettings)
    window.addEventListener('storage', syncSettings)
    return () => {
      window.removeEventListener('settings-updated', syncSettings)
      window.removeEventListener('storage', syncSettings)
    }
  }, [])

  const currentModelDisplayName = getGeminiModelDisplayName(settings.geminiModel)

  // 当前步骤视图（用户可切换步骤或启用自动跟随）
  const [activeStep, setActiveStep] = useState<ProcessingStepIndex>(1)
  const [autoFollow, setAutoFollow] = useState(true)
  const autoFollowRef = useRef(autoFollow)
  useEffect(() => {
    autoFollowRef.current = autoFollow
  }, [autoFollow])

  const [logFilter, setLogFilter] = useState<'all' | 'gemini' | 'asr' | 'tts' | 'ffmpeg'>('all')

  // 动态实时数据文本
  const [liveSourceText, setLiveSourceText] = useState<string>('')
  const [liveTransText, setLiveTransText] = useState<string>('')
  const [liveTtsMsg, setLiveTtsMsg] = useState<string>('')
  const [subCountMsg, setSubCountMsg] = useState<string>('等待音轨提取与 ASR 识别...')

  const [step1Done, setStep1Done] = useState(false)
  const [step2Done, setStep2Done] = useState(false)
  const [step3Done, setStep3Done] = useState(false)
  const [showLogDrawer, setShowLogDrawer] = useState(false)
  const [autoScrollLogs, setAutoScrollLogs] = useState(true)
  const [copiedLog, setCopiedLog] = useState(false)

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const completedRef = useRef(false)
  const logsContainerRef = useRef<HTMLDivElement | null>(null)

  const pollData = useCallback(async () => {
    try {
      const [s, latestLogs, realSubs] = await Promise.all([
        getTaskStatus(taskId),
        getTaskLogs(taskId),
        getSubtitles(taskId).catch(() => [] as SubtitleSegment[]),
      ])
      setStatus(s)

      const currentAutoStep = stageToStepNumber(s.stage)
      if (autoFollowRef.current) {
        setActiveStep(currentAutoStep)
      }

      if (realSubs && realSubs.length > 0) {
        setSubtitles(realSubs)
        setSubCountMsg(`必剪 ASR 已成功识别并拆分 ${realSubs.length} 条句子`)

        const translatedSegs = realSubs.filter(seg => seg.translated_text && seg.translated_text !== seg.source_text)
        if (translatedSegs.length > 0) {
          const lastTrans = translatedSegs[translatedSegs.length - 1]
          setLiveSourceText(lastTrans.source_text)
          setLiveTransText(lastTrans.translated_text)
        } else if (realSubs.length > 0) {
          setLiveSourceText(realSubs[0].source_text)
        }
      }

      if (latestLogs && latestLogs.length > 0) {
        setLogs(latestLogs)
        const ttsLogs = latestLogs.filter(l => l.tag.includes('音色') || l.tag.includes('TTS') || l.message.includes('语义段'))
        if (ttsLogs.length > 0) {
          setLiveTtsMsg(ttsLogs[ttsLogs.length - 1].message)
        }
      }

      if (s.stage === 'error') {
        setError(s.error ?? '处理过程中发生错误')
        if (intervalRef.current) clearInterval(intervalRef.current)
        return
      }

      const { step1Done: d1, step2Done: d2, step3Done: d3, allDone } = stageToCardState(s.stage)
      if (d1) setStep1Done(true)
      if (d2) setStep2Done(true)
      if (d3) setStep3Done(true)

      if (allDone && !completedRef.current) {
        completedRef.current = true
        if (intervalRef.current) clearInterval(intervalRef.current)
        clearActiveTaskId()
        completeTimerRef.current = setTimeout(onComplete, 1200)
      }
    } catch {
      // 网络错误，继续轮询
    }
  }, [taskId, onComplete])

  useEffect(() => {
    pollData()
    intervalRef.current = setInterval(pollData, 1500)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (completeTimerRef.current) clearTimeout(completeTimerRef.current)
    }
  }, [pollData])

  // 更新时将日志容器内部滚动到底部（不滚动窗口）
  useEffect(() => {
    if (autoScrollLogs && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight
    }
  }, [logs, autoScrollLogs])

  const copyAllLogs = () => {
    const text = logs.map(l => `[${l.timestamp}] [${l.tag}] ${l.message}`).join('\n')
    navigator.clipboard.writeText(text)
    setCopiedLog(true)
    setTimeout(() => setCopiedLog(false), 2000)
  }

  // 解析 TTS 日志以获取实时分段进度
  const parsedTts = parseTtsLogMessage(liveTtsMsg)

  // 计算动态连续进度
  let smoothProgress = status ? status.progress : 0
  if (status?.stage === 'synthesizing' && parsedTts && parsedTts.total > 0) {
    smoothProgress = Math.min(89, Math.max(70, 70 + Math.round((parsedTts.percent * 20) / 100)))
  } else if (status?.stage === 'translating' && subtitles.length > 0) {
    const translatedCount = subtitles.filter(s => s.translated_text && s.translated_text !== s.source_text).length
    const transRatio = translatedCount / subtitles.length
    smoothProgress = Math.min(69, Math.max(50, 50 + Math.round(transRatio * 20)))
  }

  const currentAutoStepIndex = status ? stageToStepNumber(status.stage) : 1

  // 筛选终端视图日志
  const filteredLogs = logs.filter((l) => {
    if (logFilter === 'all') return true
    if (logFilter === 'gemini') return l.tag.includes('Gemini') || l.tag.includes('AI 翻译')
    if (logFilter === 'asr') return l.tag.includes('ASR') || l.tag.includes('字幕')
    if (logFilter === 'tts') return l.tag.includes('TTS') || l.tag.includes('音色') || l.tag.includes('合成')
    if (logFilter === 'ffmpeg') return l.tag.includes('FFmpeg') || l.tag.includes('音频') || l.tag.includes('混音')
    return true
  })

  return (
    <div className="flex-grow flex flex-col items-center justify-start p-3 sm:p-6 max-w-6xl mx-auto w-full overflow-y-auto">
      {/* 1. 标题区域 */}
      <div className="text-center mb-6 w-full max-w-4xl">
        <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-600 dark:text-purple-400 text-xs font-semibold mb-3 backdrop-blur-md">
          <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
          <Radio className="w-3.5 h-3.5 animate-pulse" />
          沉浸式聚焦引擎 (Live Stream Focus Mode Active)
        </div>
        <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mb-2 text-slate-900 dark:text-slate-100 flex items-center justify-center gap-2">
          <Sparkles className="w-6 h-6 text-purple-500 animate-spin" />
          AI 视频智能转译控制台
        </h2>
        <div className="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2.5 mt-3 text-xs">
          <span className="text-slate-500 dark:text-slate-400 font-medium mr-1 text-xs">全自动协同</span>
          <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700/60 text-slate-700 dark:text-slate-200 font-medium text-xs shadow-2xs">
            PCM 音频抽轨
          </span>
          <ChevronRight className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
          <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700/60 text-slate-700 dark:text-slate-200 font-medium text-xs shadow-2xs">
            Bcut 字幕识别
          </span>
          <ChevronRight className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
          <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700/60 text-slate-700 dark:text-slate-200 font-medium text-xs shadow-2xs">
            {currentModelDisplayName} ({getLanguageDisplayName(status?.source_lang || settings.sourceLang, true)} ➔ {getLanguageDisplayName(status?.target_lang || settings.targetLang)})
          </span>
          <ChevronRight className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
          <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700/60 text-slate-700 dark:text-slate-200 font-medium text-xs shadow-2xs">
            MiMo 语音克隆
          </span>
        </div>
      </div>

      {error && (
        <div className="w-full max-w-4xl mb-6 p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 text-rose-600 dark:text-rose-400 text-xs sm:text-sm flex items-center gap-3 shadow-lg animate-bounce">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <div className="flex-grow">
            <span className="font-bold mr-1">处理遇到异常:</span>
            {error}
          </div>
        </div>
      )}

      {status?.preview_ready && (
        <div className="w-full max-w-5xl mb-7 flex flex-col items-center gap-3 animate-in fade-in slide-in-from-top-2">
          <div className="w-full flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-500 animate-ping" />
              <h3 className="font-extrabold text-slate-900 dark:text-slate-100 text-sm sm:text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-emerald-500" />
                流式视频秒开与后台增量缓冲 (Tencent Stream Engine)
              </h3>
            </div>
            <span className="text-xs text-emerald-600 dark:text-emerald-400 font-semibold bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
              ⚡ 首段 {Math.max(1, Math.round(status.preview_duration || 0))}s 秒开 · 后台无感续播
            </span>
          </div>
          <TencentStreamPlayer
            taskId={taskId}
            status={status}
            subtitles={subtitles}
          />
        </div>
      )}

      {/* 2. 顶部步骤条（顶部时间轴 / 步骤条） */}
      <div className="w-full max-w-5xl mb-7">
        <div className="bg-white/90 dark:bg-slate-900/80 backdrop-blur-xl rounded-2xl p-3 sm:p-4 border border-slate-200/90 dark:border-slate-800 shadow-sm flex items-center justify-between gap-2 sm:gap-3 relative overflow-hidden">
          {/* 步骤条项目 1 */}
          <button
            onClick={() => {
              setActiveStep(1)
              setAutoFollow(false)
            }}
            className={`flex-1 flex items-center gap-3 p-2.5 sm:p-3 rounded-xl transition-all text-left cursor-pointer group relative ${
              activeStep === 1
                ? 'bg-purple-50/80 dark:bg-purple-950/40 border border-purple-500/80 dark:border-purple-500/80 shadow-xs ring-1 ring-purple-500/20'
                : 'border border-transparent hover:bg-slate-100/70 dark:hover:bg-slate-800/50'
            }`}
          >
            <div
              className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 transition-all ${
                step1Done
                  ? 'bg-emerald-500 text-white shadow-sm'
                  : currentAutoStepIndex === 1
                  ? 'bg-purple-600 text-white btn-glow'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-400'
              }`}
            >
              {step1Done ? <Check className="w-5 h-5" /> : currentAutoStepIndex === 1 ? <Loader2 className="w-5 h-5 animate-spin" /> : '01'}
            </div>
            <div className="min-w-0 flex-grow hidden xs:block sm:block">
              <div className="flex items-center justify-between gap-1 mb-0.5">
                <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 dark:text-slate-500">Step 01</span>
                {step1Done ? (
                  <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60 px-1.5 py-0.2 rounded border border-emerald-200 dark:border-emerald-800">完成</span>
                ) : currentAutoStepIndex === 1 ? (
                  <span className="text-[10px] font-medium text-purple-600 dark:text-purple-400 animate-pulse">进行中</span>
                ) : (
                  <span className="text-[10px] text-slate-400">等待</span>
                )}
              </div>
              <h4 className="text-xs sm:text-sm font-bold truncate text-slate-900 dark:text-slate-100 group-hover:text-purple-600 dark:group-hover:text-purple-400 transition-colors">
                音频处理
              </h4>
            </div>
          </button>

          {/* 步骤条连接线 1-2 */}
          <div className="flex items-center shrink-0">
            {step1Done ? (
              <div className="h-0.5 w-4 sm:w-8 bg-emerald-500 rounded-full transition-all duration-300" />
            ) : currentAutoStepIndex === 1 ? (
              <div className="h-0.5 w-4 sm:w-8 bg-purple-500/80 rounded-full animate-pulse" />
            ) : (
              <div className="h-0.5 w-4 sm:w-8 border-t-2 border-dashed border-slate-300 dark:border-slate-700" />
            )}
          </div>

          {/* 步骤条项目 2 */}
          <button
            onClick={() => {
              setActiveStep(2)
              setAutoFollow(false)
            }}
            className={`flex-1 flex items-center gap-3 p-2.5 sm:p-3 rounded-xl transition-all text-left cursor-pointer group relative ${
              activeStep === 2
                ? 'bg-purple-50/80 dark:bg-purple-950/40 border border-purple-500/80 dark:border-purple-500/80 shadow-xs ring-1 ring-purple-500/20'
                : 'border border-transparent hover:bg-slate-100/70 dark:hover:bg-slate-800/50'
            }`}
          >
            <div
              className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 transition-all ${
                step2Done
                  ? 'bg-emerald-500 text-white shadow-sm'
                  : currentAutoStepIndex === 2
                  ? 'bg-purple-600 text-white btn-glow'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-400'
              }`}
            >
              {step2Done ? <Check className="w-5 h-5" /> : currentAutoStepIndex === 2 ? <Loader2 className="w-5 h-5 animate-spin" /> : '02'}
            </div>
            <div className="min-w-0 flex-grow hidden xs:block sm:block">
              <div className="flex items-center justify-between gap-1 mb-0.5">
                <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 dark:text-slate-500">Step 02</span>
                {step2Done ? (
                  <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60 px-1.5 py-0.2 rounded border border-emerald-200 dark:border-emerald-800">完成</span>
                ) : currentAutoStepIndex === 2 ? (
                  <span className="text-[10px] font-medium text-purple-600 dark:text-purple-400 animate-pulse">进行中</span>
                ) : (
                  <span className="text-[10px] text-slate-400">等待</span>
                )}
              </div>
              <h4 className="text-xs sm:text-sm font-bold truncate text-slate-900 dark:text-slate-100 group-hover:text-purple-600 dark:group-hover:text-purple-400 transition-colors">
                字幕与翻译
              </h4>
            </div>
          </button>

          {/* 步骤条连接线 2-3 */}
          <div className="flex items-center shrink-0">
            {step2Done ? (
              <div className="h-0.5 w-4 sm:w-8 bg-emerald-500 rounded-full transition-all duration-300" />
            ) : currentAutoStepIndex === 2 ? (
              <div className="h-0.5 w-4 sm:w-8 bg-purple-500/80 rounded-full animate-pulse" />
            ) : (
              <div className="h-0.5 w-4 sm:w-8 border-t-2 border-dashed border-slate-300 dark:border-slate-700" />
            )}
          </div>

          {/* 步骤条项目 3 */}
          <button
            onClick={() => {
              setActiveStep(3)
              setAutoFollow(false)
            }}
            className={`flex-1 flex items-center gap-3 p-2.5 sm:p-3 rounded-xl transition-all text-left cursor-pointer group relative ${
              activeStep === 3
                ? 'bg-purple-50/80 dark:bg-purple-950/40 border border-purple-500/80 dark:border-purple-500/80 shadow-xs ring-1 ring-purple-500/20'
                : 'border border-transparent hover:bg-slate-100/70 dark:hover:bg-slate-800/50'
            }`}
          >
            <div
              className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 transition-all ${
                step3Done
                  ? 'bg-emerald-500 text-white shadow-sm'
                  : currentAutoStepIndex === 3
                  ? 'bg-purple-600 text-white btn-glow'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-400'
              }`}
            >
              {step3Done ? <Check className="w-5 h-5" /> : currentAutoStepIndex === 3 ? <Loader2 className="w-5 h-5 animate-spin" /> : '03'}
            </div>
            <div className="min-w-0 flex-grow hidden xs:block sm:block">
              <div className="flex items-center justify-between gap-1 mb-0.5">
                <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 dark:text-slate-500">Step 03</span>
                {step3Done ? (
                  <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60 px-1.5 py-0.2 rounded border border-emerald-200 dark:border-emerald-800">完成</span>
                ) : currentAutoStepIndex === 3 ? (
                  <span className="text-[10px] font-medium text-purple-600 dark:text-purple-400 animate-pulse">进行中</span>
                ) : (
                  <span className="text-[10px] text-slate-400">等待</span>
                )}
              </div>
              <h4 className="text-xs sm:text-sm font-bold truncate text-slate-900 dark:text-slate-100 group-hover:text-purple-600 dark:group-hover:text-purple-400 transition-colors">
                音色合成
              </h4>
            </div>
          </button>

          {!autoFollow && (
            <button
              onClick={() => {
                setAutoFollow(true)
                setActiveStep(currentAutoStepIndex)
              }}
              className="text-[10px] font-medium text-purple-600 dark:text-purple-400 hover:underline px-2 py-1 bg-purple-50 dark:bg-purple-950/40 rounded-lg shrink-0 border border-purple-200 dark:border-purple-800 cursor-pointer"
            >
              恢复自动跟踪
            </button>
          )}
        </div>
      </div>

      {/* 3. 浅色主题实时处理控制面板 */}
      <div className="w-full max-w-5xl rounded-2xl overflow-hidden bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 shadow-xl dark:shadow-2xl transition-all duration-300 flex flex-col min-h-[520px]">
        {/* 聚焦卡片顶部栏 */}
        <div className="bg-slate-50/90 dark:bg-slate-950/80 px-5 py-3 border-b border-slate-200/90 dark:border-slate-800 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-rose-400 inline-block" />
              <span className="w-3 h-3 rounded-full bg-amber-400 inline-block" />
              <span className="w-3 h-3 rounded-full bg-emerald-400 inline-block" />
            </div>
            <span className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate border-l border-slate-200 dark:border-slate-800 pl-3">
              Task #{taskId.slice(0, 8)}
            </span>
            {status && (
              <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-500/10 text-purple-700 dark:text-purple-400 border border-purple-200 dark:border-purple-500/20 truncate">
                {stageLabel(status.stage)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <span className="text-xs font-mono text-slate-600 dark:text-slate-400 hidden sm:inline mr-1">
              Progress: <strong className="text-purple-600 dark:text-purple-400 font-semibold">{smoothProgress}%</strong>
            </span>
            {onNavigateToHistory && (
              <Button
                size="sm"
                variant="outline"
                onClick={onNavigateToHistory}
                className="text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border-slate-200 dark:border-slate-700 h-7 px-2.5 rounded-lg flex items-center gap-1.5 cursor-pointer shadow-2xs"
              >
                <ArrowLeft className="w-3.5 h-3.5 text-slate-500" />
                后台运行 / 浏览历史
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowLogDrawer(true)}
              className="text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border-slate-200 dark:border-slate-700 h-7 px-2.5 rounded-lg flex items-center gap-1.5 cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5 text-purple-500" />
              全屏模态框
            </Button>
          </div>
        </div>

        {/* 聚焦卡片主体分栏（40% : 60%） */}
        <div className="flex-grow grid grid-cols-1 md:grid-cols-12 min-h-[460px]">
          {/* 左侧栏（40% 宽度 - 浅色主题可视化区域） */}
          <div className="md:col-span-5 bg-slate-50/70 dark:bg-slate-900/90 text-slate-900 dark:text-white p-6 flex flex-col justify-between relative overflow-hidden border-b md:border-b-0 md:border-r border-slate-200/90 dark:border-slate-800 backdrop-blur-xl">
            {/* 柔和环境背光光晕 */}
            <div className="absolute top-1/4 left-1/4 w-48 h-48 bg-purple-500/10 dark:bg-purple-600/15 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute bottom-1/4 right-1/4 w-48 h-48 bg-indigo-500/10 dark:bg-indigo-600/15 rounded-full blur-3xl pointer-events-none" />

            {/* 左侧卡片视图动画容器 */}
            <div key={activeStep} className="animate-slide-fade-in flex flex-col h-full justify-between z-10">
              {/* 步骤 1 可视化器：音频波形 */}
              {activeStep === 1 && (
                <>
                  <div>
                    <div className="flex items-center gap-2.5 mb-4">
                      <div className="w-10 h-10 rounded-xl bg-purple-100 dark:bg-purple-500/20 border border-purple-200 dark:border-purple-500/40 text-purple-600 dark:text-purple-400 flex items-center justify-center">
                        <Layers className="w-5 h-5" />
                      </div>
                      <div>
                        <span className="text-[10px] font-mono text-purple-600 dark:text-purple-400 uppercase tracking-widest">Step 01 — Focus</span>
                        <h3 className="text-base font-bold text-slate-900 dark:text-white">PCM 音频提轨与频谱解析</h3>
                      </div>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mb-6 leading-relaxed">
                      从原生 MP4 视频提取 16kHz 高保真单声道音频轨，消除环境噪音并对齐对白时间戳。
                    </p>

                    {/* 音频均衡器波形卡片 */}
                    <div className="p-5 bg-white dark:bg-slate-950/80 rounded-2xl border border-slate-200/90 dark:border-slate-800 shadow-xs flex flex-col items-center justify-center min-h-[140px] relative overflow-hidden">
                      <div className="flex items-end justify-center gap-1.5 h-16 mb-3">
                        {Array.from({ length: 15 }).map((_, i) => (
                          <div
                            key={i}
                            className={`w-2 rounded-full transition-all duration-300 ${
                              step1Done ? 'bg-emerald-500 dark:bg-emerald-400 h-8' : 'bg-purple-600 dark:bg-purple-500 animate-pulse'
                            }`}
                            style={{
                              height: step1Done
                                ? `${(Math.sin(i) * 0.4 + 0.6) * 40 + 10}px`
                                : `${((i * 7) % 11 + 3) * 5}px`,
                              animationDelay: `${i * 0.12}s`,
                            }}
                          />
                        ))}
                      </div>
                      <span className="text-[11px] font-mono text-purple-700 dark:text-purple-300 flex items-center gap-1.5">
                        <Volume2 className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 animate-bounce" />
                        {step1Done ? 'PCM 单声道音轨解析完毕' : 'FFmpeg 音频提轨中 (Live PCM Stream)...'}
                      </span>
                    </div>
                  </div>

                  {/* 音频规格元数据标签 */}
                  <div className="mt-6 space-y-2">
                    <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                      <div className="p-2.5 rounded-xl bg-white dark:bg-slate-950/50 border border-slate-200/90 dark:border-slate-800/80 shadow-xs">
                        <span className="text-slate-400 dark:text-slate-500 block text-[10px]">采样率 / 声道</span>
                        <span className="text-purple-700 dark:text-purple-300 font-bold">16,000 Hz / Mono</span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-white dark:bg-slate-950/50 border border-slate-200/90 dark:border-slate-800/80 shadow-xs">
                        <span className="text-slate-400 dark:text-slate-500 block text-[10px]">处理引擎</span>
                        <span className="text-purple-700 dark:text-purple-300 font-bold">FFmpeg v6.1</span>
                      </div>
                    </div>

                    <div className="p-3 rounded-xl bg-purple-50 dark:bg-purple-500/10 border border-purple-200 dark:border-purple-500/20 text-xs text-purple-700 dark:text-purple-300 flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                        音轨提取状态
                      </span>
                      <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        {step1Done ? '100% Ready' : `${status?.stage === 'extracting_audio' ? status.progress : 0}%`}
                      </span>
                    </div>
                  </div>
                </>
              )}

              {/* 步骤 2 可视化器：字幕与 Gemini 打字机效果 */}
              {activeStep === 2 && (
                <>
                  <div>
                    <div className="flex items-center gap-2.5 mb-4">
                      <div className="w-10 h-10 rounded-xl bg-indigo-100 dark:bg-indigo-500/20 border border-indigo-200 dark:border-indigo-500/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                        <Languages className="w-5 h-5" />
                      </div>
                      <div>
                        <span className="text-[10px] font-mono text-indigo-600 dark:text-indigo-400 uppercase tracking-widest">Step 02 — Focus</span>
                        <h3 className="text-base font-bold text-slate-900 dark:text-white">字幕识别与 {currentModelDisplayName} 润色</h3>
                      </div>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mb-5 leading-relaxed">
                      必剪 ASR 对白精确断句 ➔ {currentModelDisplayName} 大模型结合上下文进行信达雅翻译润色。
                    </p>

                    {/* 双字幕打字机卡片 */}
                    <div className="p-4 bg-white dark:bg-slate-950/80 rounded-2xl border border-slate-200/90 dark:border-slate-800 shadow-xs space-y-3 relative">
                      {liveSourceText ? (
                        <>
                          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800">
                            <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono mb-1">
                              <span>ORIGINAL SPEECH</span>
                              <span className="text-purple-600 dark:text-purple-400">ASR Stream</span>
                            </div>
                            <p className="text-xs text-slate-800 dark:text-slate-300 font-sans leading-relaxed">
                              "{liveSourceText}"
                            </p>
                          </div>

                          <div className="flex items-center justify-center">
                            <ArrowRight className="w-4 h-4 text-indigo-500 animate-pulse" />
                          </div>

                          <div className="p-3 rounded-xl bg-indigo-50/80 dark:bg-indigo-950/40 border border-indigo-200/80 dark:border-indigo-800/60">
                            <div className="flex items-center justify-between text-[10px] text-indigo-600 dark:text-indigo-400 font-mono mb-1">
                              <span className="flex items-center gap-1">
                                <Sparkles className="w-3 h-3" /> GEMINI AI TRANSLATION
                              </span>
                              <span className="text-emerald-600 dark:text-emerald-400 font-bold">Live</span>
                            </div>
                            <p className="text-xs text-slate-900 dark:text-white font-medium leading-relaxed">
                              "{liveTransText || 'Gemini 翻译处理中...'}"
                            </p>
                          </div>
                        </>
                      ) : (
                        <div className="py-8 flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 text-xs gap-2">
                          <Bot className="w-6 h-6 text-indigo-500 animate-bounce" />
                          <span>{subCountMsg}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 字幕进度底栏 */}
                  <div className="mt-6 space-y-2">
                    <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 font-mono">
                      <span>已成功分词对白:</span>
                      <strong className="text-indigo-600 dark:text-indigo-400">{subtitles.length} 句</strong>
                    </div>
                    <Progress
                      value={step2Done ? 100 : status?.stage === 'translating' ? status.progress : 25}
                      className="h-1.5 bg-slate-200 dark:bg-slate-800 [&>div]:bg-indigo-600 dark:[&>div]:bg-indigo-500"
                    />
                  </div>
                </>
              )}

              {/* 步骤 3 可视化器：MiMo 合成光晕（实时同步区域） */}
              {activeStep === 3 && (
                <>
                  <div>
                    <div className="flex items-center gap-2.5 mb-4">
                      <div className="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-500/20 border border-blue-200 dark:border-blue-500/40 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                        <Mic className="w-5 h-5" />
                      </div>
                      <div>
                        <span className="text-[10px] font-mono text-blue-600 dark:text-blue-400 uppercase tracking-widest">Step 03 — Focus</span>
                        <h3 className="text-base font-bold text-slate-900 dark:text-white">MiMo 音色克隆与多轨合成</h3>
                      </div>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mb-5 leading-relaxed">
                      基于原作者声音特征克隆 MiMo 声学模型，生成流畅自然的中配语音并与背景音乐混音。
                    </p>

                    {/* 动态实时 TTS 进度卡片 */}
                    <div className="p-5 bg-white dark:bg-slate-950/80 rounded-2xl border border-slate-200/90 dark:border-slate-800 shadow-xs flex flex-col items-center justify-center min-h-[160px] relative overflow-hidden">
                      {/* 脉冲光晕动画 */}
                      <div className="relative w-16 h-16 flex items-center justify-center mb-3">
                        <div className="absolute inset-0 rounded-full bg-blue-500/20 animate-pulse-ring" />
                        <div className="absolute inset-2 rounded-full bg-purple-500/30 animate-ping" style={{ animationDuration: '3s' }} />
                        <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-purple-600 to-indigo-600 flex items-center justify-center shadow-md z-10">
                          <Bot className="w-5 h-5 text-white" />
                        </div>
                      </div>

                      {/* 实时解析的分段计数器与进度条 */}
                      {parsedTts ? (
                        <div className="w-full text-center space-y-2 z-10">
                          <div className="flex items-center justify-between text-xs font-mono">
                            <span className="text-purple-600 dark:text-purple-400 font-bold bg-purple-50 dark:bg-purple-950/60 px-2 py-0.5 rounded border border-purple-200 dark:border-purple-800">
                              语义段 [{parsedTts.current} / {parsedTts.total}]
                            </span>
                            <span className="text-slate-500 dark:text-slate-400 font-bold">
                              {parsedTts.percent}%
                            </span>
                          </div>

                          {parsedTts.text && (
                            <p className="text-xs text-slate-800 dark:text-slate-200 font-sans italic truncate max-w-full px-1">
                              "{parsedTts.text}"
                            </p>
                          )}

                          <Progress
                            value={parsedTts.percent}
                            className="h-2 bg-slate-100 dark:bg-slate-800 [&>div]:bg-gradient-to-r [&>div]:from-purple-500 [&>div]:to-indigo-500 transition-all duration-500"
                          />
                        </div>
                      ) : (
                        <span className="text-xs font-mono text-blue-700 dark:text-blue-300 text-center truncate max-w-[260px] z-10">
                          {liveTtsMsg || 'MiMo Zero-Shot Acoustic Engine...'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 多轨混音状态 */}
                  <div className="mt-6 space-y-2">
                    <div className="p-3 rounded-xl bg-white dark:bg-slate-950/60 border border-slate-200/90 dark:border-slate-800 shadow-xs text-[11px] font-mono space-y-1.5">
                      <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                        <span>[Track 1] MiMo 中文克隆配音</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-bold">Active</span>
                      </div>
                      <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                        <span>[Track 2] 原声背景音乐 BGM</span>
                        <span className="text-blue-600 dark:text-blue-400 font-bold">Ducked</span>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* 右侧栏（60% 宽度 - 简洁的明暗开发者控制台界面） */}
          <div className="md:col-span-7 bg-slate-50/90 dark:bg-[#0B0F19] text-slate-800 dark:text-slate-200 font-mono flex flex-col justify-between border-t md:border-t-0 border-slate-200/90 dark:border-slate-800 relative">
            {/* 终端标题栏与工具栏 */}
            <div className="bg-slate-100/90 dark:bg-slate-950/90 px-4 py-2.5 border-b border-slate-200/90 dark:border-slate-800 flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span className="text-slate-800 dark:text-slate-300 font-bold tracking-wide">process.log</span>
                <span className="text-[10px] text-slate-500 px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-900 border border-slate-300 dark:border-slate-800 font-medium">
                  {filteredLogs.length} events
                </span>
              </div>

              {/* 日志分类筛选标签 */}
              <div className="flex items-center gap-1 text-[10px]">
                <button
                  onClick={() => setLogFilter('all')}
                  className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                    logFilter === 'all'
                      ? 'bg-purple-600 text-white font-bold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800'
                  }`}
                >
                  全部
                </button>
                <button
                  onClick={() => setLogFilter('gemini')}
                  className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                    logFilter === 'gemini'
                      ? 'bg-purple-600 text-white font-bold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800'
                  }`}
                >
                  Gemini
                </button>
                <button
                  onClick={() => setLogFilter('tts')}
                  className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                    logFilter === 'tts'
                      ? 'bg-purple-600 text-white font-bold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800'
                  }`}
                >
                  MiMo
                </button>
                <button
                  onClick={() => setLogFilter('ffmpeg')}
                  className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                    logFilter === 'ffmpeg'
                      ? 'bg-purple-600 text-white font-bold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800'
                  }`}
                >
                  FFmpeg
                </button>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  onClick={copyAllLogs}
                  title="复制终端日志"
                  className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors cursor-pointer"
                >
                  {copiedLog ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* 终端主体内容区 */}
            <div ref={logsContainerRef} className="flex-grow p-4 sm:p-5 overflow-y-auto max-h-[380px] min-h-[340px] space-y-2.5 text-xs select-text scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-800 scrollbar-track-transparent">
              {filteredLogs.length > 0 ? (
                filteredLogs.map((item, index) => {
                  const isSuccess = item.type === 'success' || item.message.includes('成功') || item.message.includes('✓')
                  const isError = item.type === 'error' || item.message.includes('错误')
                  const isApi = item.type === 'api' || item.tag.includes('Gemini')

                  return (
                    <div key={index} className="flex items-start gap-2.5 leading-relaxed hover:bg-slate-200/60 dark:hover:bg-slate-900/80 px-2 py-1.5 rounded-md transition-colors">
                      <span className="text-slate-400 dark:text-slate-500 shrink-0 text-[11px] font-mono pt-0.5">[{item.timestamp}]</span>

                      {/* 标签徽章 */}
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded font-medium shrink-0 border leading-tight ${
                          item.tag.includes('Gemini') || item.tag.includes('AI')
                            ? 'bg-cyan-100 dark:bg-cyan-950/40 text-cyan-700 dark:text-cyan-300 border-cyan-200 dark:border-cyan-800/40'
                            : item.tag.includes('ASR') || item.tag.includes('字幕')
                            ? 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/40'
                            : item.tag.includes('TTS') || item.tag.includes('合成') || item.tag.includes('音色')
                            ? 'bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800/40'
                            : 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800/40'
                        }`}
                      >
                        {item.tag}
                      </span>

                      {/* 消息内容 */}
                      <span
                        className={`break-all leading-relaxed ${
                          isSuccess
                            ? 'text-emerald-700 dark:text-[#6EE7B7] font-semibold'
                            : isError
                            ? 'text-rose-600 dark:text-rose-400 font-semibold'
                            : isApi
                            ? 'text-indigo-700 dark:text-indigo-300'
                            : 'text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {item.message}
                      </span>
                    </div>
                  )
                })
              ) : (
                <div className="py-12 flex flex-col items-center justify-center text-slate-400 dark:text-slate-600 text-xs gap-2">
                  <Terminal className="w-8 h-8 opacity-40 animate-pulse" />
                  <span>等待服务器推播实时处理日志...</span>
                </div>
              )}
            </div>

            {/* 终端底栏 */}
            <div className="bg-slate-100/90 dark:bg-slate-950 px-4 py-2 border-t border-slate-200/90 dark:border-slate-800 flex items-center justify-between text-[11px] text-slate-500">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                <span>Status: Socket Stream Active</span>
              </div>
              <button
                onClick={() => setAutoScrollLogs(!autoScrollLogs)}
                className={`hover:underline cursor-pointer ${autoScrollLogs ? 'text-purple-600 dark:text-purple-400 font-bold' : 'text-slate-500'}`}
              >
                Auto-scroll: {autoScrollLogs ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 任务详情模态抽屉 */}
      <TaskDetailDrawer
        taskId={taskId}
        isOpen={showLogDrawer}
        onClose={() => setShowLogDrawer(false)}
      />
    </div>
  )
}
