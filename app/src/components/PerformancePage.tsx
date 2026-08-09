import { useEffect, useState } from 'react'
import {
  Activity, AudioLines, CheckCircle2, Cpu, Gauge, Info, Languages,
  Layers3, MemoryStick, RotateCcw, Save, ServerCog, TriangleAlert,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  getPerformanceSettings,
  updatePerformanceSettings,
  type PerformanceResponse,
  type PerformanceSettings,
} from '@/lib/api'

const DEFAULT_RECOMMENDED: PerformanceSettings = {
  max_concurrent_tasks: 4,
  translate_concurrency: 3,
  translate_batch_size: 20,
  tts_concurrency: 6,
}

function getRecommendedSettings(hardware?: { logical_cores: number; memory_gb: number | null } | null): PerformanceSettings {
  if (!hardware) return DEFAULT_RECOMMENDED
  const cores = hardware.logical_cores || 4
  const memory = hardware.memory_gb || 8

  if (cores <= 4 || memory <= 8) {
    return {
      max_concurrent_tasks: 2,
      translate_concurrency: 2,
      translate_batch_size: 15,
      tts_concurrency: 4,
    }
  }

  if (cores <= 8 || memory <= 16) {
    return {
      max_concurrent_tasks: 3,
      translate_concurrency: 3,
      translate_batch_size: 20,
      tts_concurrency: 6,
    }
  }

  const taskCount = Math.min(6, Math.max(4, Math.floor(cores / 3)))
  const ttsCount = Math.min(12, Math.max(6, Math.floor(cores * 0.5)))
  return {
    max_concurrent_tasks: taskCount,
    translate_concurrency: 4,
    translate_batch_size: 25,
    tts_concurrency: ttsCount,
  }
}

type SettingKey = keyof PerformanceSettings

const CONTROLS: Array<{
  key: SettingKey
  title: string
  description: string
  min: number
  max: number
  icon: typeof Cpu
  color: string
  warningThreshold?: number
  warning?: string
}> = [
  {
    key: 'max_concurrent_tasks',
    title: '完整任务并发',
    description: '允许同时执行的完整视频流水线数量，超出部分自动排队',
    min: 1,
    max: 12,
    icon: Layers3,
    color: 'text-indigo-600 bg-indigo-500/10 dark:text-indigo-400 dark:bg-indigo-500/15',
    warningThreshold: 6,
    warning: '超过 6 可能同时启动较多 FFmpeg 与 ASR 任务',
  },
  {
    key: 'translate_concurrency',
    title: '模型并发',
    description: '所有任务共享的 AI 模型批次请求槽位',
    min: 1,
    max: 8,
    icon: Languages,
    color: 'text-violet-600 bg-violet-500/10 dark:text-violet-400 dark:bg-violet-500/15',
    warningThreshold: 4,
    warning: '并发过高可能触发 API 429 速率限制',
  },
  {
    key: 'translate_batch_size',
    title: '字幕批次大小',
    description: '每次发送给 AI 模型的字幕条数，长视频可适当调大',
    min: 5,
    max: 50,
    icon: Gauge,
    color: 'text-purple-600 bg-purple-500/10 dark:text-purple-400 dark:bg-purple-500/15',
  },
  {
    key: 'tts_concurrency',
    title: 'MiMo TTS 并发',
    description: '所有任务共享的语音分段合成请求槽位',
    min: 1,
    max: 16,
    icon: AudioLines,
    color: 'text-fuchsia-600 bg-fuchsia-500/10 dark:text-fuchsia-400 dark:bg-fuchsia-500/15',
    warningThreshold: 8,
    warning: '建议从 6 开始，稳定后再逐步提高到 8',
  },
]

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)))
}

export default function PerformancePage() {
  const [data, setData] = useState<PerformanceResponse | null>(null)
  const [settings, setSettings] = useState<PerformanceSettings>(DEFAULT_RECOMMENDED)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const handleApplyRecommended = () => {
    const recommended = getRecommendedSettings(data?.hardware)
    setSettings(recommended)
    const chipName = data?.hardware.chip ? data.hardware.chip.split(' ')[0] : '本机硬件'
    setMessage({
      type: 'success',
      text: `已根据 ${chipName} (${data?.hardware.logical_cores || '--'}逻辑核心 / ${data?.hardware.memory_gb || '--'}GB内存) 智能自动分配最合适并发配置`,
    })
  }

  useEffect(() => {
    getPerformanceSettings()
      .then((response) => {
        setData(response)
        setSettings(response.settings)
      })
      .catch(() => setMessage({ type: 'error', text: '无法读取性能配置，请确认后端服务已启动' }))
      .finally(() => setLoading(false))
  }, [])

  const updateValue = (key: SettingKey, value: number) => {
    const control = CONTROLS.find((item) => item.key === key)
    if (!control) return
    setSettings((current) => ({
      ...current,
      [key]: clamp(value, control.min, control.max),
    }))
    setMessage(null)
  }

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const response = await updatePerformanceSettings(settings)
      setData(response)
      setSettings(response.settings)
      setMessage({ type: 'success', text: '性能配置已立即生效，并已保存到本机' })
    } catch {
      setMessage({ type: 'error', text: '保存失败，请检查后端服务连接' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex-grow flex flex-col w-full bg-slate-50/70 dark:bg-slate-950/50 px-4 sm:px-6 lg:px-8 py-6 sm:py-8 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl space-y-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-400">
              <ServerCog className="h-7 w-7 stroke-[1.75]" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">性能调度中心</h1>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">调整本地流水线与云端请求并发，保存后立即生效</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleApplyRecommended}
              title="根据当前电脑 CPU 核心数与内存自动计算并分配最佳性能并发"
              className="rounded-xl border-slate-200/80 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <RotateCcw className="mr-2 h-4 w-4 text-violet-500" />
              <span>根据本机硬件智能匹配推荐值</span>
            </Button>
            <Button
              onClick={save}
              disabled={saving || loading}
              className="rounded-xl bg-violet-600 hover:bg-violet-700 text-white shadow-xs shadow-violet-600/20 cursor-pointer"
            >
              <Save className="mr-2 h-4 w-4" /> {saving ? '保存中...' : '应用配置'}
            </Button>
          </div>
        </div>

        {message && (
          <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm transition-all ${
            message.type === 'success'
              ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400'
          }`}>
            {message.type === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <TriangleAlert className="h-4 w-4 shrink-0" />}
            {message.text}
          </div>
        )}

        {/* 顶部三卡片：数据可视化微调 */}
        <div className="grid gap-4 sm:grid-cols-3">
          <HardwareCard
            icon={Cpu}
            label="处理器"
            numericValue={data?.hardware.chip ?? '读取中...'}
            detail={`${data?.hardware.logical_cores ?? '--'} 个逻辑核心`}
            iconBg="bg-violet-500/10 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400"
          />
          <HardwareCard
            icon={MemoryStick}
            label="统一内存"
            numericValue={data?.hardware.memory_gb ?? '--'}
            unit="GB"
            detail="本地任务共享内存池"
            iconBg="bg-sky-500/10 text-sky-600 dark:bg-sky-500/15 dark:text-sky-400"
          />
          <HardwareCard
            icon={Activity}
            label="正在运行"
            numericValue={data?.runtime.tasks_active ?? 0}
            unit="个任务"
            detail={`翻译 ${data?.runtime.translate_active ?? 0} · TTS ${data?.runtime.tts_active ?? 0}`}
            iconBg="bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
          />
        </div>

        {/* 核心交互区：重塑 4 个调度卡片 */}
        <div className="grid gap-4 lg:grid-cols-2">
          {CONTROLS.map(({ key: itemKey, ...control }) => (
            <ParameterCard
              key={itemKey}
              {...control}
              value={settings[itemKey]}
              disabled={loading}
              onChange={(value) => updateValue(itemKey, value)}
            />
          ))}
        </div>

        {/* 底部说明卡片：完美宽度对齐与简约灰色微卡片 */}
        <div className="rounded-2xl border border-slate-200/80 bg-slate-100/80 dark:border-slate-800/80 dark:bg-slate-900/50 p-5 text-xs sm:text-sm text-slate-600 dark:text-slate-400 shadow-xs space-y-2">
          <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-200">
            <Info className="h-4 w-4 text-violet-600 dark:text-violet-400 shrink-0" />
            <span>智能硬件感知与调度说明</span>
          </div>
          <p className="leading-relaxed">
            系统启动时会自动精准识别您当前电脑的 <strong>CPU 芯片型号、逻辑核心数与内存大小</strong>，全面兼容 Windows (x86/ARM64)、macOS 及 Linux。点击右上角“智能匹配推荐值”，即可根据您的具体硬件规格一键自动分配最佳并发与资源。
          </p>
          <p className="leading-relaxed text-slate-500 dark:text-slate-500">
            降低并发不会中断已在运行的任务；AI 模型与 MiMo 属于云端服务，若遇到 429 速率限制可微调降低云端并发槽位。
          </p>
        </div>
      </div>
    </div>
  )
}

function HardwareCard({
  icon: Icon,
  label,
  numericValue,
  unit,
  detail,
  iconBg,
}: {
  icon: typeof Cpu
  label: string
  numericValue: string | number
  unit?: string
  detail: string
  iconBg: string
}) {
  return (
    <div className="rounded-2xl border border-slate-100 dark:border-slate-800/60 bg-white dark:bg-slate-900/90 p-5 hover-card-lift">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">{label}</p>
          <div className="mt-2 flex items-baseline gap-1.5 flex-wrap">
            <span className="text-2xl font-bold font-mono tracking-tight text-slate-900 dark:text-slate-100">
              {numericValue}
            </span>
            {unit && (
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {unit}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 truncate">{detail}</p>
        </div>
        <div className={`rounded-xl p-2.5 shrink-0 transition-colors ${iconBg}`}>
          <Icon className="h-5 w-5 stroke-[1.75]" />
        </div>
      </div>
    </div>
  )
}

function ParameterCard({
  title,
  description,
  min,
  max,
  icon: Icon,
  color,
  warningThreshold,
  warning,
  value,
  disabled,
  onChange,
}: {
  title: string
  description: string
  min: number
  max: number
  icon: typeof Cpu
  color: string
  warningThreshold?: number
  warning?: string
  value: number
  disabled: boolean
  onChange: (value: number) => void
}) {
  const percentage = ((value - min) / (max - min)) * 100
  const isWarningActive = warningThreshold !== undefined ? value > warningThreshold : Boolean(warning)

  return (
    <div className="rounded-2xl border border-slate-100 dark:border-slate-800/60 bg-white dark:bg-slate-900/90 p-5 hover-card-lift">
      <div className="flex items-start gap-3.5">
        <div className={`rounded-xl p-2.5 shrink-0 ${color}`}>
          <Icon className="h-5 w-5 stroke-[1.75]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-900 dark:text-slate-100 text-sm sm:text-base">{title}</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{description}</p>
            </div>

            {/* 右上角数值框：浅紫色圆角微型 Pill / Tag 读数 */}
            <div className="flex items-center justify-center px-3 py-1 rounded-full bg-violet-500/10 dark:bg-violet-500/15 border border-violet-500/20 text-violet-600 dark:text-violet-400 shrink-0 transition-all hover:bg-violet-500/20">
              <input
                type="number"
                min={min}
                max={max}
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(Number(event.target.value))}
                className="w-9 bg-transparent text-center font-mono text-base font-bold text-violet-600 dark:text-violet-400 focus:outline-none cursor-text select-all"
              />
            </div>
          </div>

          {/* 物理质感滑块 Track & Thumb */}
          <div className="mt-4">
            <input
              type="range"
              min={min}
              max={max}
              value={value}
              disabled={disabled}
              onChange={(event) => onChange(Number(event.target.value))}
              style={{
                background: `linear-gradient(to right, #8B5CF6 0%, #8B5CF6 ${percentage}%, var(--color-slate-200, #E2E8F0) ${percentage}%, var(--color-slate-200, #E2E8F0) 100%)`,
              }}
              className="range-slider cursor-pointer"
            />
            {/* 极值调淡小字体 */}
            <div className="mt-1 flex justify-between text-[10px] font-mono text-slate-400 dark:text-slate-500 tracking-wider">
              <span>{min}</span>
              <span>{max}</span>
            </div>
          </div>

          {/* 收敛警报信息 Warning Text */}
          {warning && isWarningActive && (
            <div className="mt-3 flex items-center gap-1.5 text-[11px] text-amber-800/90 dark:text-amber-300/90 bg-amber-500/10 dark:bg-amber-500/15 px-2.5 py-1 rounded-lg w-fit transition-all duration-300 animate-in fade-in slide-in-from-top-1">
              <TriangleAlert className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
              <span>{warning}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
