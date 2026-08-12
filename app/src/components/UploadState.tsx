import { useState, useRef, useEffect } from 'react'
import { ArrowLeftRight, Upload, Sparkles, PartyPopper, AlertCircle, Terminal, FileText, CheckCircle2, Clock, Zap, Volume2, VolumeX, RefreshCcw } from 'lucide-react'
import { uploadVideo, startTask, fetchServerSettings, fetchGeminiModels } from '@/lib/api'
import { saveActiveTaskId } from '@/lib/task-session'
import {
  loadSettings,
  saveSettings,
  mergeFillEmpty,
  getGeminiModelDisplayName,
  getLanguageDisplayName,
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
  VOICES,
  type AppSettings,
} from './SettingsPanel'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'

interface UploadStateProps {
  onUploadComplete: (taskId: string) => void
}

interface LogEntry {
  id: string
  timestamp: string
  tag: string
  tagType: 'info' | 'process' | 'success'
  message: string
}

export default function UploadState({ onUploadComplete }: UploadStateProps) {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [morphing, setMorphing] = useState(false)
  const [progressWidth, setProgressWidth] = useState('0%')
  const [progressPercent, setProgressPercent] = useState(0)
  const [statusText, setStatusText] = useState('视频解析中...')
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [refreshingModels, setRefreshingModels] = useState(false)

  useEffect(() => {
    function syncSettings() {
      setSettings(loadSettings())
    }
    window.addEventListener('settings-updated', syncSettings)
    window.addEventListener('storage', syncSettings)
    fetchServerSettings().then((serverData) => {
      if (serverData && (serverData.geminiApiKey || serverData.geminiModel)) {
        setSettings((prev) => {
          const merged = mergeFillEmpty(prev, serverData)
          localStorage.setItem('shiyibao-settings', JSON.stringify(merged))
          return merged
        })
      }
    })
    return () => {
      window.removeEventListener('settings-updated', syncSettings)
      window.removeEventListener('storage', syncSettings)
    }
  }, [])

  // 自动根据配置的 API Key 和 Base URL 拉取最新可用 AI 模型列表
  useEffect(() => {
    if (settings.geminiApiKey && (!settings.customGeminiModels || settings.customGeminiModels.length === 0)) {
      fetchGeminiModels(settings.geminiApiKey, settings.geminiApiUrl, settings.geminiApiFormat)
        .then((models) => {
          if (models && models.length > 0) {
            const formatted = models.map((m) => ({ id: m.id, name: m.name }))
            setSettings((prev) => {
              const updated: AppSettings = {
                ...prev,
                customGeminiModels: formatted,
                geminiModel: formatted.some(f => f.id === prev.geminiModel) ? prev.geminiModel : formatted[0].id,
              }
              saveSettings(updated)
              return updated
            })
          }
        })
        .catch(() => { /* 自动无感重试，忽略错 */ })
    }
  }, [settings.geminiApiKey, settings.geminiApiUrl, settings.geminiApiFormat])

  async function handleRefreshModels() {
    if (!settings.geminiApiKey) return
    setRefreshingModels(true)
    try {
      const models = await fetchGeminiModels(settings.geminiApiKey, settings.geminiApiUrl, settings.geminiApiFormat)
      if (models && models.length > 0) {
        const formatted = models.map((m) => ({ id: m.id, name: m.name }))
        const updated: AppSettings = {
          ...settings,
          customGeminiModels: formatted,
          geminiModel: formatted.some(f => f.id === settings.geminiModel) ? settings.geminiModel : formatted[0].id,
        }
        setSettings(updated)
        saveSettings(updated)
      }
    } catch {
      /* 静默 */
    } finally {
      setRefreshingModels(false)
    }
  }

  function getTimestamp() {
    const now = new Date()
    return now.toTimeString().split(' ')[0]
  }

  function addLog(message: string, tag: string = '系统', tagType: 'info' | 'process' | 'success' = 'info') {
    const entry: LogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: getTimestamp(),
      tag,
      tagType,
      message,
    }
    setLogs((prev) => [entry, ...prev])
  }

  async function handleFile(file: File) {
    if (morphing) return
    setError(null)

    let settings = loadSettings()
    if (!settings.geminiApiKey || !settings.xiaomiTtsKey) {
      const serverData = await fetchServerSettings()
      if (serverData && (serverData.geminiApiKey || serverData.xiaomiTtsKey)) {
        settings = mergeFillEmpty(settings, serverData)
        saveSettings(settings)
      }
    }

    if (!settings.geminiApiKey) {
      setError('请先在设置中填写 Gemini API Key')
      addLog('错误：未检测到 Gemini API Key', '校验', 'info')
      return
    }
    if (!settings.xiaomiTtsKey) {
      setError('请先在设置中填写小米 MiMo TTS Key')
      addLog('错误：未检测到小米 MiMo TTS Key', '校验', 'info')
      return
    }

    setMorphing(true)
    setStatusText('正在准备视频流传输...')
    setProgressWidth('15%')
    setProgressPercent(15)
    setLogs([])

    addLog(`接收文件: ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`, '接收', 'process')

    try {
      addLog('校验音视频编码格式 (H.264/AAC)...', '校验', 'info')
      await new Promise((resolve) => setTimeout(resolve, 300))

      setStatusText('正在上传视频源文件...')
      setProgressWidth('40%')
      setProgressPercent(40)
      addLog('上传至云端转译节点中...', '传输', 'process')

      const { task_id } = await uploadVideo(file)

      addLog(`视频上传完成，生成 Task ID: ${task_id.substring(0, 8)}...`, '存储', 'success')
      setStatusText('正在启动 AI 语义转译推理...')
      setProgressWidth('75%')
      setProgressPercent(75)

      const currentModel = settings.geminiModel || 'gemini-2.0-flash'
      const apiFormat = settings.geminiApiFormat || 'Gemini'
      addLog(`配置 AI [${apiFormat} | ${getGeminiModelDisplayName(currentModel)}] 翻译引擎...`, 'AI', 'process')
      const sourceLangLabel = (settings.sourceLang || 'auto') === 'auto'
        ? '自动识别 (Auto)'
        : getLanguageDisplayName(settings.sourceLang, true)
      addLog(`初始语言配置: ${sourceLangLabel}${(settings.sourceLang || 'auto') === 'auto' ? ' (系统将在音频解析时自动判别)' : ''}`, '配置', 'info')
      addLog(`绑定音色模型: ${settings.mimoVoice || '默认预设'}`, '配置', 'info')
      const origVol = settings.originalAudioVolume ?? 0.2
      addLog(`原音保留比例: ${origVol <= 0 ? '已静音 (0%)' : `${Math.round(origVol * 100)}%`}`, '配置', 'info')


      await startTask(task_id, {
        gemini_api_key: settings.geminiApiKey,
        gemini_api_url: settings.geminiApiUrl || '',
        gemini_api_format: apiFormat,
        mimo_api_key: settings.xiaomiTtsKey,
        gemini_model: currentModel,
        voice: settings.mimoVoice,
        source_lang: settings.sourceLang || 'auto',
        target_lang: settings.targetLang || 'zh',
        stream_mode: settings.streamMode || 'streaming',
        original_audio_volume: origVol,
      })

      // 后端接收任务后立即持久化，避免短暂过渡动画期间刷新导致任务无法恢复。
      saveActiveTaskId(task_id)

      setProgressWidth('100%')
      setProgressPercent(100)
      setStatusText('任务就绪，正在跳转工作台...')
      addLog('全流程启动成功，进入处理队列', '就绪', 'success')

      setTimeout(() => onUploadComplete(task_id), 500)
    } catch (err) {
      setMorphing(false)
      setProgressWidth('0%')
      setProgressPercent(0)
      const errMsg = err instanceof Error ? err.message : '上传失败，请重试'
      setError(errMsg)
      addLog(`异常中断: ${errMsg}`, '错误', 'info')
    }
  }

  function handleClick() {
    if (morphing) return
    fileInputRef.current?.click()
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) handleFile(file)
  }

  return (
    <div className="relative flex-grow flex items-center justify-center px-4 sm:px-6 lg:px-8 xl:px-12 py-4 sm:py-6 lg:py-8 overflow-y-auto">
      {/* 科技感极淡微网格背景 */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#e2e8f018_1px,transparent_1px),linear-gradient(to_bottom,#e2e8f018_1px,transparent_1px)] bg-[size:3.5rem_3.5rem] dark:bg-[linear-gradient(to_right,#1e293b25_1px,transparent_1px),linear-gradient(to_bottom,#1e293b25_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_70%_70%_at_50%_50%,#000_60%,transparent_100%)] pointer-events-none" />

      {/* 底层弥散光晕 */}
      <div className="absolute top-1/3 left-1/4 -translate-x-1/2 -translate-y-1/2 w-[550px] h-[350px] bg-slate-200/40 dark:bg-slate-800/25 blur-[140px] rounded-full pointer-events-none -z-10" />
      <div className="absolute bottom-1/3 right-1/4 translate-x-1/3 translate-y-1/3 w-[450px] h-[300px] bg-blue-500/5 dark:bg-blue-400/10 blur-[130px] rounded-full pointer-events-none -z-10" />

      {/* 65% / 35% 双栏网格容器 */}
      <div className="w-full max-w-7xl mx-auto flex flex-col lg:flex-row gap-6 lg:gap-10 xl:gap-12 items-stretch relative z-10 my-auto">
        {/* 左侧 65%：主工作区 (核心拖拽上传) */}
        <div className="w-full lg:w-[65%] flex flex-col justify-center">
          {/* 左侧头部标语区 */}
          <div className="mb-4 sm:mb-6">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 border border-slate-200/80 dark:border-slate-700/60 mb-2.5 sm:mb-3.5 shadow-2xs">
              <PartyPopper className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              <span>SaaS 工作台 · 高维 AI 音视频转译</span>
            </div>
            <h1 className="text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 leading-tight mb-2 sm:mb-3">
              AI 赋能，打破语言边界
            </h1>
            <p className="text-xs sm:text-sm lg:text-base text-slate-500 dark:text-slate-400 max-w-xl leading-relaxed font-normal">
              一键实现海外视频高精度字幕翻译与母语级音色重构，让内容跨国界无缝传播。
            </p>
          </div>

          {error && (
            <Alert variant="destructive" className="mb-6 rounded-2xl border-destructive/20 bg-destructive/5 text-destructive backdrop-blur-sm">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="ml-2 font-medium">
                {error}
              </AlertDescription>
            </Alert>
          )}

          <Input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/x-matroska"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* 紧凑贴合型双向语言选择工具栏 */}
          <div className="mb-4 flex justify-start">
            <div className="inline-flex items-center gap-1.5 p-1.5 rounded-2xl bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border border-slate-200/80 dark:border-slate-800 shadow-sm transition-all">
              {/* 初始语言选择 */}
              <div className="flex items-center gap-1.5 pl-2">
                <span className="text-xs font-medium text-slate-400 dark:text-slate-500 shrink-0 select-none">
                  初始语言:
                </span>
                <Select
                  value={settings.sourceLang || 'auto'}
                  onValueChange={(val) => {
                    if (!val) return
                    const updated: AppSettings = { ...settings, sourceLang: val }
                    setSettings(updated)
                    saveSettings(updated)
                  }}
                >
                  <SelectTrigger className="h-8 px-2.5 min-w-[95px] text-xs font-semibold bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 border-0 rounded-xl cursor-pointer transition-colors">
                    <SelectValue>{getLanguageDisplayName(settings.sourceLang, true)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-lg">
                    {SOURCE_LANGUAGES.map((lang) => (
                      <SelectItem key={lang.id} value={lang.id} className="text-xs cursor-pointer">
                        {lang.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* 中间翻转/对调按钮 ⇄ */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  const curSource = settings.sourceLang || 'auto'
                  const curTarget = settings.targetLang || 'zh'

                  let nextSource: string
                  let nextTarget: string

                  if (curSource === 'auto') {
                    nextSource = curTarget
                    nextTarget = curTarget === 'zh' ? 'en' : 'zh'
                  } else {
                    nextSource = curTarget
                    nextTarget = curSource
                  }

                  const updated: AppSettings = { ...settings, sourceLang: nextSource, targetLang: nextTarget }
                  setSettings(updated)
                  saveSettings(updated)
                }}
                title="一键翻转/互换源语言与目标语言"
                className="w-8 h-8 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-purple-100 dark:hover:bg-purple-950/60 text-slate-600 dark:text-slate-300 hover:text-purple-600 dark:hover:text-purple-400 flex items-center justify-center shrink-0 transition-all cursor-pointer group shadow-2xs"
              >
                <ArrowLeftRight className="w-3.5 h-3.5 group-hover:rotate-180 transition-transform duration-300" />
              </button>

              {/* 目标语言选择 */}
              <div className="flex items-center gap-1.5 pr-1">
                <span className="text-xs font-medium text-slate-400 dark:text-slate-500 pl-1 shrink-0 select-none">
                  目标语言:
                </span>
                <Select
                  value={settings.targetLang || 'zh'}
                  onValueChange={(val) => {
                    if (!val) return
                    const updated: AppSettings = { ...settings, targetLang: val }
                    setSettings(updated)
                    saveSettings(updated)
                  }}
                >
                  <SelectTrigger className="h-8 px-2.5 min-w-[90px] text-xs font-semibold bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 border-0 rounded-xl cursor-pointer transition-colors">
                    <SelectValue>{getLanguageDisplayName(settings.targetLang)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-lg">
                    {TARGET_LANGUAGES.map((lang) => (
                      <SelectItem key={lang.id} value={lang.id} className="text-xs cursor-pointer">
                        {lang.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* 左侧核心毛玻璃卡片 */}
          <div
            onClick={handleClick}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`w-full relative cursor-pointer group transition-all duration-300 ease-out rounded-3xl p-8 sm:p-12 flex flex-col items-center justify-center min-h-[320px] text-center overflow-hidden backdrop-blur-2xl border hover-card-lift ${
              isDragging
                ? 'border-blue-500/60 dark:border-blue-400/60 bg-blue-50/30 dark:bg-slate-900/80 shadow-2xl shadow-blue-500/10 scale-[1.01] ring-2 ring-blue-500/20'
                : 'bg-white/60 dark:bg-slate-900/50 border-white/80 dark:border-slate-800/80 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.05)] dark:shadow-[0_20px_60px_-15px_rgba(0,0,0,0.5)] hover:border-slate-300 dark:hover:border-slate-700'
            }`}
          >
            {/* 未上传状态内容 */}
            {!morphing && (
              <div className="flex flex-col items-center pointer-events-none transition-all duration-300">
                <div className="w-18 h-18 rounded-2xl bg-white dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/80 flex items-center justify-center mb-5 shadow-xs group-hover:scale-[1.03] group-hover:bg-slate-50 dark:group-hover:bg-slate-800 transition-all duration-300">
                  <Upload className="w-8 h-8 text-slate-700 dark:text-slate-200 stroke-[1.5] transition-transform duration-300 group-hover:-translate-y-1" />
                </div>

                <p className="text-base sm:text-lg font-medium text-slate-800 dark:text-slate-200 tracking-tight">
                  {(!settings.sourceLang || settings.sourceLang === 'auto') ? (
                    <>
                      拖拽视频文件至此处（<span className="text-purple-600 dark:text-purple-400 font-semibold px-0.5">自动识别</span>原声语言），一键转译为 <span className="text-purple-600 dark:text-purple-400 font-semibold px-0.5">{getLanguageDisplayName(settings.targetLang)}</span>，或
                    </>
                  ) : (
                    <>
                      拖拽 <span className="text-purple-600 dark:text-purple-400 font-semibold px-0.5">{getLanguageDisplayName(settings.sourceLang, true)}</span> 视频文件至此处，一键转译为 <span className="text-purple-600 dark:text-purple-400 font-semibold px-0.5">{getLanguageDisplayName(settings.targetLang)}</span>，或
                    </>
                  )}
                  <span className="text-blue-600 dark:text-blue-400 font-semibold underline underline-offset-4 decoration-blue-300 dark:decoration-blue-700 group-hover:decoration-blue-500 transition-colors ml-1">点击上传</span>
                </p>

                <p className="text-xs sm:text-sm text-slate-400 dark:text-slate-500 font-normal mt-1.5">
                  支持 MP4, MOV, MKV 格式 (单文件最大上限 2GB)
                </p>

                <div className="mt-8 flex flex-wrap items-center justify-center gap-2 text-xs text-slate-400 dark:text-slate-500">
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-100/70 dark:bg-slate-800/50 border border-slate-200/60 dark:border-slate-700/40">
                    <Zap className="w-3 h-3 text-blue-500" /> 4K 高清解析
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-100/70 dark:bg-slate-800/50 border border-slate-200/60 dark:border-slate-700/40">
                    <Clock className="w-3 h-3 text-blue-500" /> 秒级处理响应
                  </span>
                </div>
              </div>
            )}

            {/* 变形进度加载状态 */}
            {morphing && (
              <div className="w-full max-w-md flex flex-col items-center justify-center py-4 animate-in fade-in duration-300">
                <div className="w-14 h-14 rounded-2xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200/60 dark:border-blue-800/60 flex items-center justify-center mb-5 shadow-xs">
                  <Sparkles className="w-6 h-6 text-blue-600 dark:text-blue-400 animate-spin" />
                </div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">
                  {statusText}
                </h3>
                <p className="text-xs text-slate-400 dark:text-slate-500 mb-6">
                  已完成 {progressPercent}% · 请勿关闭当前页面
                </p>

                {/* 低饱和商务蓝进度条 */}
                <div className="w-full h-2.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden relative p-0.5 border border-slate-200/60 dark:border-slate-700/60">
                  <div
                    className="h-full bg-blue-600 dark:bg-blue-500 rounded-full progress-fill transition-[width] duration-500 ease-out"
                    style={{ width: progressWidth }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 视频原声保留音量快捷调控栏 */}
          <div className="mt-4 w-full p-3.5 sm:p-4 rounded-2xl bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border border-slate-200/80 dark:border-slate-800 shadow-sm transition-all flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 shrink-0">
              <div className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors ${
                (settings.originalAudioVolume ?? 0.2) <= 0
                  ? 'bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400'
                  : 'bg-purple-100 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400'
              }`}>
                {(settings.originalAudioVolume ?? 0.2) <= 0 ? (
                  <VolumeX className="w-4 h-4 stroke-[1.5]" />
                ) : (
                  <Volume2 className="w-4 h-4 stroke-[1.5]" />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                    原视频原音音量
                  </span>
                  <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-md border ${
                    (settings.originalAudioVolume ?? 0.2) <= 0
                      ? 'bg-rose-50 dark:bg-rose-950/80 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/60'
                      : 'bg-purple-50 dark:bg-purple-950/80 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800/60'
                  }`}>
                    {(settings.originalAudioVolume ?? 0.2) <= 0
                      ? '已静音 (0%)'
                      : `${Math.round((settings.originalAudioVolume ?? 0.2) * 100)}%`}
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 font-normal">
                  合成成片时原声音轨的保留比例 (0% 即为纯配音)
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 flex-1 max-w-xs">
              <button
                type="button"
                onClick={() => {
                  const updated: AppSettings = { ...settings, originalAudioVolume: 0.0 }
                  setSettings(updated)
                  saveSettings(updated)
                }}
                title="关掉原声 (0%)"
                className="p-1 text-slate-400 hover:text-rose-500 transition-colors shrink-0 border-0 bg-transparent cursor-pointer"
              >
                <VolumeX className="w-4 h-4" />
              </button>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={Math.round((settings.originalAudioVolume ?? 0.2) * 100)}
                onChange={(e) => {
                  const val = Math.max(0, Math.min(100, Number(e.target.value))) / 100
                  const updated: AppSettings = { ...settings, originalAudioVolume: val }
                  setSettings(updated)
                  saveSettings(updated)
                }}
                className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-600 dark:accent-purple-400"
              />
              <button
                type="button"
                onClick={() => {
                  const updated: AppSettings = { ...settings, originalAudioVolume: 1.0 }
                  setSettings(updated)
                  saveSettings(updated)
                }}
                title="最大原声音量 (100%)"
                className="p-1 text-slate-400 hover:text-purple-600 transition-colors shrink-0 border-0 bg-transparent cursor-pointer"
              >
                <Volume2 className="w-4 h-4" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                const cur = settings.originalAudioVolume ?? 0.2
                const next = cur > 0 ? 0.0 : 0.2
                const updated: AppSettings = { ...settings, originalAudioVolume: next }
                setSettings(updated)
                saveSettings(updated)
              }}
              className={`px-3 py-1.5 text-xs font-semibold rounded-xl border transition-all shrink-0 cursor-pointer ${
                (settings.originalAudioVolume ?? 0.2) <= 0
                  ? 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-200/60'
              }`}
            >
              {(settings.originalAudioVolume ?? 0.2) > 0 ? '一键静音原声' : '开启原声 (20%)'}
            </button>
          </div>
        </div>

        {/* 右侧 35%：日志 / 交互侧边面板 */}
        <div className="w-full lg:w-[35%] flex flex-col">
          <div className="w-full h-full bg-slate-50/80 dark:bg-slate-900/40 border border-slate-200/80 dark:border-slate-800/80 rounded-3xl p-6 sm:p-7 flex flex-col justify-between backdrop-blur-md shadow-xs min-h-[420px]">
            {/* 面板头部 */}
            <div className="flex items-center justify-between pb-4 border-b border-slate-200/60 dark:border-slate-800/60 mb-5">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 tracking-tight">
                  处理动态
                </span>
              </div>
              <div>
                {!morphing && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-0.5 rounded-full bg-slate-200/60 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                    等待任务
                  </span>
                )}
                {morphing && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200/60 dark:border-blue-800/60">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-ping" />
                    处理中
                  </span>
                )}
              </div>
            </div>

            {/* 面板内容区 */}
            <div className="flex-grow flex flex-col justify-start">
              {/* 空状态占位与骨架屏 */}
              {logs.length === 0 && (
                <div className="flex-grow flex flex-col justify-between py-2">
                  {/* 骨架屏加载器 */}
                  <div className="space-y-4 mb-6 opacity-75">
                    <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/60 dark:bg-slate-800/40 border border-slate-200/40 dark:border-slate-700/30 animate-pulse">
                      <div className="w-12 h-4 bg-slate-200/80 dark:bg-slate-700/60 rounded-md" />
                      <div className="w-10 h-4 bg-slate-200/60 dark:bg-slate-700/40 rounded-full" />
                      <div className="w-24 h-4 bg-slate-200/80 dark:bg-slate-700/60 rounded-md" />
                    </div>

                    <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/40 dark:bg-slate-800/20 border border-slate-200/30 dark:border-slate-700/20 animate-pulse">
                      <div className="w-12 h-4 bg-slate-200/60 dark:bg-slate-700/40 rounded-md" />
                      <div className="w-10 h-4 bg-slate-200/40 dark:bg-slate-700/30 rounded-full" />
                      <div className="w-32 h-4 bg-slate-200/60 dark:bg-slate-700/40 rounded-md" />
                    </div>

                    <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/30 dark:bg-slate-800/10 border border-slate-200/20 dark:border-slate-700/10 animate-pulse">
                      <div className="w-12 h-4 bg-slate-200/40 dark:bg-slate-700/30 rounded-md" />
                      <div className="w-10 h-4 bg-slate-200/30 dark:bg-slate-700/20 rounded-full" />
                      <div className="w-20 h-4 bg-slate-200/40 dark:bg-slate-700/30 rounded-md" />
                    </div>
                  </div>

                  {/* 空状态文字与图标说明 */}
                  <div className="flex flex-col items-center text-center p-4 rounded-2xl bg-white/50 dark:bg-slate-800/30 border border-slate-200/50 dark:border-slate-800/50 my-auto">
                    <FileText className="w-8 h-8 text-slate-300 dark:text-slate-600 stroke-[1.2] mb-2" />
                    <p className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      暂无在线处理任务
                    </p>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed max-w-[220px]">
                      在左侧拖拽或点击上传视频后，此处将实时呈现在线解压、音轨提取与多模态转译日志。
                    </p>
                  </div>
                </div>
              )}

              {/* 实时日志流，交错淡入 */}
              {logs.length > 0 && (
                <div className="space-y-2.5 overflow-y-auto max-h-[300px] pr-1">
                  {logs.map((log) => (
                    <div
                      key={log.id}
                      className="p-2.5 rounded-xl bg-white/80 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/50 text-xs flex items-start gap-2.5 animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out shadow-2xs"
                    >
                      <span className="text-[10px] text-slate-400 font-mono pt-0.5">
                        {log.timestamp}
                      </span>

                      {log.tagType === 'process' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200/60 dark:border-blue-800/60 flex-shrink-0">
                          {log.tag}
                        </span>
                      )}
                      {log.tagType === 'success' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/60 flex-shrink-0 flex items-center gap-1">
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          {log.tag}
                        </span>
                      )}
                      {log.tagType === 'info' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-600 flex-shrink-0">
                          {log.tag}
                        </span>
                      )}

                      <span className="text-slate-700 dark:text-slate-200 leading-relaxed font-mono break-all">
                        {log.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 面板底部脚标：引擎模型与 TTS 音色双可切换机制 */}
            <div className="pt-3.5 border-t border-slate-200/60 dark:border-slate-800/60 flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <div className="flex flex-wrap items-center gap-2">
                {/* 翻译引擎快速切换 */}
                <div className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                  <span className="text-slate-400 dark:text-slate-500 shrink-0 select-none">引擎:</span>
                  {settings.geminiApiKey && (
                    <button
                      type="button"
                      onClick={handleRefreshModels}
                      disabled={refreshingModels}
                      title="从 API 接口重新在线刷新可用 AI 模型"
                      className="p-0.5 hover:bg-slate-200/60 dark:hover:bg-slate-800 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors disabled:opacity-50"
                    >
                      <RefreshCcw className={`w-3 h-3 ${refreshingModels ? 'animate-spin' : ''}`} />
                    </button>
                  )}
                  <Select
                    value={settings.geminiModel || 'gemini-2.0-flash'}
                    onValueChange={(val) => {
                      if (!val) return
                      const updated: AppSettings = { ...settings, geminiModel: val }
                      setSettings(updated)
                      saveSettings(updated)
                    }}
                  >
                    <SelectTrigger className="h-6 px-1.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800/80 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 border-0 rounded-md cursor-pointer transition-colors max-w-[220px]">
                      <SelectValue>{getGeminiModelDisplayName(settings.geminiModel, settings.customGeminiModels)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent className="min-w-[280px] max-w-[360px] max-h-[320px] bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-xl overflow-y-auto">
                      {settings.customGeminiModels && settings.customGeminiModels.length > 0 ? (
                        <SelectGroup>
                          <SelectLabel className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold px-2 py-1">
                            ✨ API 动态拉取模型 ({settings.customGeminiModels.length})
                          </SelectLabel>
                          {settings.customGeminiModels.map((m) => (
                            <SelectItem key={m.id} value={m.id} className="text-xs cursor-pointer py-1.5 pr-4">
                              {m.name || m.id}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ) : (
                        <div className="p-3 text-center text-xs text-slate-400 dark:text-slate-500">
                          {settings.geminiApiKey ? '正在/请点击刷新按钮拉取 API 模型...' : '请先在【偏好设置】配置 API Key'}
                        </div>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                {/* TTS 音色快速切换 */}
                <div className="flex items-center gap-1">
                  <span className="text-slate-400 dark:text-slate-500 shrink-0 select-none">音色:</span>
                  <Select
                    value={settings.mimoVoice || '冰糖'}
                    onValueChange={(val) => {
                      if (!val) return
                      const updated: AppSettings = { ...settings, mimoVoice: val }
                      setSettings(updated)
                      saveSettings(updated)
                    }}
                  >
                    <SelectTrigger className="h-6 px-1.5 text-[11px] font-medium text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/40 hover:bg-purple-100 dark:hover:bg-purple-900/40 border-0 rounded-md cursor-pointer transition-colors">
                      <SelectValue>{settings.mimoVoice || '冰糖'}</SelectValue>
                    </SelectTrigger>
                    <SelectContent className="min-w-[160px] max-h-[280px] bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-xl overflow-y-auto">
                      {VOICES.map((v) => (
                        <SelectItem key={v.id} value={v.id} className="text-xs cursor-pointer py-1.5">
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* 原声音量快速切换 */}
                <div className="flex items-center gap-1">
                  <span className="text-slate-400 dark:text-slate-500 shrink-0 select-none">原音:</span>
                  <button
                    type="button"
                    onClick={() => {
                      const cur = settings.originalAudioVolume ?? 0.2
                      const next = cur > 0 ? 0.0 : 0.2
                      const updated: AppSettings = { ...settings, originalAudioVolume: next }
                      setSettings(updated)
                      saveSettings(updated)
                    }}
                    title="点击切换原声音量：静音 (0%) 或 保留 (20%)"
                    className={`h-6 px-1.5 text-[11px] font-medium rounded-md cursor-pointer transition-colors inline-flex items-center gap-1 ${
                      (settings.originalAudioVolume ?? 0.2) <= 0
                        ? 'text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100'
                        : 'text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200/60'
                    }`}
                  >
                    {(settings.originalAudioVolume ?? 0.2) <= 0 ? (
                      <>
                        <VolumeX className="w-3 h-3 text-rose-500" />
                        <span>静音</span>
                      </>
                    ) : (
                      <>
                        <Volume2 className="w-3 h-3 text-purple-500" />
                        <span>{Math.round((settings.originalAudioVolume ?? 0.2) * 100)}%</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              <span className="text-slate-400 dark:text-slate-500 text-[10px] shrink-0">工作台 v2.4</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
