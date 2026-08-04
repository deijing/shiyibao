import { useState, useEffect } from 'react'
import { Settings, Eye, EyeOff, Sliders, KeyRound, Mic, Zap, CheckCircle2, AlertCircle, Loader2, ExternalLink, RefreshCcw, Languages, Shield, ShieldCheck, Volume2, VolumeX } from 'lucide-react'
import { GithubIcon } from './GithubIcon'
import { ChangelogModal } from './ChangelogModal'
import { EnvironmentCheckModal } from './EnvironmentCheckModal'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogClose,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { testGeminiKey, testXiaomiKey, fetchGeminiModels, fetchServerSettings, saveServerSettings } from '@/lib/api'

const STORAGE_KEY = 'shiyibao-settings'

export interface AppSettings {
  geminiApiKey: string
  geminiApiUrl?: string
  geminiApiFormat?: 'Gemini' | 'OpenAI' | 'OpenAI-Response' | 'Anthropic'
  geminiModel: string
  xiaomiTtsKey: string
  mimoVoice: string
  sourceLang: string
  targetLang: string
  streamMode?: 'streaming' | 'batch'
  originalAudioVolume?: number
  customGeminiModels?: { id: string; name: string }[]
}

export const SOURCE_LANGUAGES = [
  { id: 'auto', label: '🌐 自动识别 (Auto)' },
  { id: 'en', label: '🇺🇸 英语 (English)' },
  { id: 'zh', label: '🇨🇳 中文 (Chinese)' },
  { id: 'ja', label: '🇯🇵 日语 (Japanese)' },
  { id: 'ko', label: '🇰🇷 韩语 (Korean)' },
  { id: 'fr', label: '🇫🇷 法语 (French)' },
  { id: 'de', label: '🇩🇪 德语 (German)' },
  { id: 'es', label: '🇪🇸 西班牙语 (Spanish)' },
  { id: 'ru', label: '🇷🇺 俄语 (Russian)' },
]

export const TARGET_LANGUAGES = [
  { id: 'zh', label: '🇨🇳 中文 (Chinese)' },
  { id: 'en', label: '🇺🇸 英语 (English)' },
  { id: 'ja', label: '🇯🇵 日语 (Japanese)' },
  { id: 'ko', label: '🇰🇷 韩语 (Korean)' },
  { id: 'fr', label: '🇫🇷 法语 (French)' },
  { id: 'de', label: '🇩🇪 德语 (German)' },
  { id: 'es', label: '🇪🇸 西班牙语 (Spanish)' },
  { id: 'ru', label: '🇷🇺 俄语 (Russian)' },
]

export function getLanguageDisplayName(langId?: string, isSource = false): string {
  if (!langId) return isSource ? '自动检测' : '中文'
  if (langId === 'auto') return '自动识别'
  if (langId === 'zh') return '中文'
  if (langId === 'en') return '英文'
  if (langId === 'ja') return '日语'
  if (langId === 'ko') return '韩语'
  if (langId === 'fr') return '法语'
  if (langId === 'de') return '德语'
  if (langId === 'es') return '西班牙语'
  if (langId === 'ru') return '俄语'
  return langId
}

export const VOICES = [
  { id: '冰糖', label: '冰糖（女声）', lang: 'zh' },
  { id: '茉莉', label: '茉莉（女声）', lang: 'zh' },
  { id: '苏打', label: '苏打（男声）', lang: 'zh' },
  { id: '白桦', label: '白桦（男声）', lang: 'zh' },
  { id: 'Mia', label: 'Mia (Female)', lang: 'en' },
  { id: 'Chloe', label: 'Chloe (Female)', lang: 'en' },
  { id: 'Milo', label: 'Milo (Male)', lang: 'en' },
  { id: 'Dean', label: 'Dean (Male)', lang: 'en' },
]

import { GeminiLogo, DeepSeekLogo, KimiLogo, DoubaoLogo, OpenAILogo, ClaudeLogo } from './BrandLogos'

export interface ApiPreset {
  id: string
  name: string
  logo: React.ComponentType<{ className?: string }>
  format: 'Gemini' | 'OpenAI' | 'OpenAI-Response' | 'Anthropic'
  baseUrl: string
  defaultModel: string
  getKeyUrl: string
}

export const AI_PRESETS: ApiPreset[] = [
  {
    id: 'gemini',
    name: '谷歌 Gemini',
    logo: GeminiLogo,
    format: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.0-flash',
    getKeyUrl: 'https://aistudio.google.com/api-keys',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    logo: DeepSeekLogo,
    format: 'OpenAI',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    getKeyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    logo: KimiLogo,
    format: 'OpenAI',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    getKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'doubao',
    name: '豆包',
    logo: DoubaoLogo,
    format: 'OpenAI',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-pro-32k',
    getKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'openai',
    name: 'OpenAI 官方',
    logo: OpenAILogo,
    format: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    defaultModel: 'gpt-4o-mini',
    getKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'claude',
    name: 'Anthropic Claude',
    logo: ClaudeLogo,
    format: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-3-5-sonnet-20241022',
    getKeyUrl: 'https://console.anthropic.com/',
  },
]

export const DEFAULT_GEMINI_MODELS = [
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (推荐 - 高速多模态)' },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite (高性价比轻量级)' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash (快速全能)' },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro (深度推理/长上下文)' },
]

export function getGeminiModelDisplayName(modelId?: string): string {
  if (!modelId) return 'Gemini 2.0 Flash'
  if (modelId === 'gemini-2.0-flash') return 'Gemini 2.0 Flash'
  if (modelId === 'gemini-2.5-flash-lite') return 'Gemini 2.5 Flash-Lite'
  if (modelId === 'gemini-2.5-flash') return 'Gemini 2.5 Flash'
  if (modelId === 'gemini-1.5-flash') return 'Gemini 1.5 Flash'
  if (modelId === 'gemini-1.5-pro') return 'Gemini 1.5 Pro'

  // 标准化原始字符串格式
  return modelId
    .split('/')
    .pop()!
    .replace(/^gemini-/i, 'Gemini ')
}

export function getApiPreviewUrl(format?: string, baseUrl?: string, model?: string): string {
  const fmt = format || 'Gemini'
  const cleanBase = (baseUrl || '').trim().replace(/\/+$/, '')
  const cleanModel = (model || 'gemini-2.0-flash').replace(/^models\//, '')

  if (fmt === 'OpenAI-Response') {
    const root = cleanBase || 'https://api.openai.com'
    if (root.includes('/responses')) return root
    if (root.endsWith('/v1')) return `${root}/responses`
    return `${root}/v1/responses`
  }

  if (fmt === 'OpenAI') {
    const root = cleanBase || 'https://api.openai.com'
    if (root.includes('/chat/completions')) return root
    if (root.endsWith('/v1')) return `${root}/chat/completions`
    return `${root}/v1/chat/completions`
  }

  if (fmt === 'Anthropic') {
    const root = cleanBase || 'https://api.anthropic.com'
    if (root.includes('/messages')) return root
    if (root.endsWith('/v1')) return `${root}/messages`
    return `${root}/v1/messages`
  }

  const root = cleanBase || 'https://generativelanguage.googleapis.com'
  if (root.includes(':generateContent')) return root
  if (root.includes('/v1beta/models/')) return `${root}:generateContent`
  if (root.endsWith('/v1beta')) return `${root}/models/${cleanModel}:generateContent`
  return `${root}/v1beta/models/${cleanModel}:generateContent`
}

export function getApiKeyConsoleUrl(baseUrl?: string, format?: string): { url: string; label: string } {
  const url = (baseUrl || '').toLowerCase()

  if (url.includes('deepseek')) {
    return { url: 'https://platform.deepseek.com/api_keys', label: '获取 DeepSeek Key' }
  }
  if (url.includes('moonshot') || url.includes('kimi')) {
    return { url: 'https://platform.moonshot.cn/console/api-keys', label: '获取 Kimi Key' }
  }
  if (url.includes('volcengine') || url.includes('volces')) {
    return { url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', label: '获取豆包 Key' }
  }
  if (format === 'Anthropic' || url.includes('anthropic')) {
    return { url: 'https://console.anthropic.com/settings/keys', label: '获取 Claude Key' }
  }
  if (format === 'OpenAI' || format === 'OpenAI-Response' || url.includes('openai')) {
    return { url: 'https://platform.openai.com/api-keys', label: '获取 OpenAI Key' }
  }

  return { url: 'https://aistudio.google.com/app/apikey', label: '获取 Gemini Key' }
}

const DEFAULT_SETTINGS: AppSettings = {
  geminiApiKey: '',
  geminiApiUrl: '',
  geminiApiFormat: 'Gemini',
  geminiModel: 'gemini-2.0-flash',
  xiaomiTtsKey: '',
  mimoVoice: '冰糖',
  sourceLang: 'auto',
  targetLang: 'zh',
  streamMode: 'streaming',
  originalAudioVolume: 0.2,
  customGeminiModels: [],
}

export function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) }
  } catch { /* 忽略 */ }
  return DEFAULT_SETTINGS
}

export function saveSettings(settings: AppSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  saveServerSettings(settings)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('settings-updated'))
  }
}

/**
 * 用服务端保存的配置填充本地空字段，避免覆盖用户已有的本地值。
 * `loadSettings()` 始终返回完整对象（未设置的键为空字符串），因此无论哪个方向
 * 的直接展开合并都不正确——仅当本地值为空或缺失时才复制服务端值。
 */
export function mergeFillEmpty(
  local: AppSettings,
  server: Record<string, any>,
): AppSettings {
  const merged: Record<string, any> = { ...local }
  for (const key of Object.keys(server)) {
    const serverVal = server[key]
    const localVal = merged[key]
    const localEmpty =
      localVal === undefined ||
      localVal === null ||
      localVal === '' ||
      (Array.isArray(localVal) && localVal.length === 0)
    if (serverVal !== undefined && serverVal !== null && serverVal !== '' && localEmpty) {
      merged[key] = serverVal
    }
  }
  return merged as AppSettings
}

export default function SettingsPanel() {
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [showGeminiKey, setShowGeminiKey] = useState(false)
  const [showXiaomiKey, setShowXiaomiKey] = useState(false)

  const [testingGemini, setTestingGemini] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [testingXiaomi, setTestingXiaomi] = useState(false)
  const [geminiVerified, setGeminiVerified] = useState(false)
  const [xiaomiVerified, setXiaomiVerified] = useState(false)

  const [geminiResult, setGeminiResult] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  const [xiaomiResult, setXiaomiResult] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  useEffect(() => {
    // 页面/弹窗加载时，向后端拉取已保存的默认配置（防御跨端口 / 清缓存场景）
    fetchServerSettings().then((serverData) => {
      if (serverData && (serverData.geminiApiKey || serverData.xiaomiTtsKey)) {
        setSettings((prev) => {
          const merged = {
            ...prev,
            geminiApiKey: prev.geminiApiKey || serverData.geminiApiKey || '',
            xiaomiTtsKey: prev.xiaomiTtsKey || serverData.xiaomiTtsKey || '',
            geminiModel: prev.geminiModel || serverData.geminiModel || 'gemini-2.0-flash',
            mimoVoice: prev.mimoVoice || serverData.mimoVoice || '冰糖',
            targetLang: prev.targetLang || serverData.targetLang || 'zh',
          }
          localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
          return merged
        })
      }
    })
  }, [])



  async function handleTestGemini() {
    setTestingGemini(true)
    setGeminiResult(null)
    try {
      const res = await testGeminiKey(settings.geminiApiKey, settings.geminiApiUrl, settings.geminiApiFormat)
      setGeminiVerified(true)
      setGeminiResult({
        type: 'success',
        message: res.message || 'API Key 校验成功！通信正常。',
      })
    } catch (err) {
      setGeminiVerified(false)
      setGeminiResult({
        type: 'error',
        message: err instanceof Error ? err.message : 'API Key 无效或无法建立通信连接',
      })
    } finally {
      setTestingGemini(false)
    }
  }

  async function handleFetchGeminiModels() {
    if (!settings.geminiApiKey.trim()) {
      setGeminiResult({
        type: 'error',
        message: '请先输入 API Key 再尝试获取模型列表',
      })
      return
    }
    setFetchingModels(true)
    setGeminiResult(null)
    try {
      const models = await fetchGeminiModels(settings.geminiApiKey, settings.geminiApiUrl, settings.geminiApiFormat)
      setGeminiVerified(true)
      if (models.length > 0) {
        const formatted = models.map((m) => ({ id: m.id, name: m.name }))
        setSettings((s) => ({
          ...s,
          customGeminiModels: formatted,
          geminiModel: formatted.some(f => f.id === s.geminiModel) ? s.geminiModel : formatted[0].id,
        }))
        setGeminiResult({
          type: 'success',
          message: `拉取成功！检索到 ${models.length} 个可用 AI 模型。`,
        })
      } else {
        setGeminiResult({
          type: 'error',
          message: '未检索到该 API 支持生成能力的模型',
        })
      }
    } catch (err) {
      setGeminiResult({
        type: 'error',
        message: err instanceof Error ? err.message : '获取 AI 模型列表失败',
      })
    } finally {
      setFetchingModels(false)
    }
  }

  async function handleTestXiaomi() {
    setTestingXiaomi(true)
    setXiaomiResult(null)
    try {
      const res = await testXiaomiKey(settings.xiaomiTtsKey)
      setXiaomiVerified(true)
      setXiaomiResult({
        type: 'success',
        message: res.message || '小米 TTS Key 校验成功！语音通信正常。',
      })
    } catch (err) {
      setXiaomiVerified(false)
      setXiaomiResult({
        type: 'error',
        message: err instanceof Error ? err.message : 'API Key 无效或无法建立通信连接',
      })
    } finally {
      setTestingXiaomi(false)
    }
  }

  // 仅在明确点击“保存偏好设置”时持久化配置。每次打开对话框时重新加载已保存的
  // 值，确保点击“取消”或关闭时会真正丢弃未保存的草稿修改（面板在整个应用周期内保持挂载）。
  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setSettings(loadSettings())
      setGeminiResult(null)
      setXiaomiResult(null)
      setGeminiVerified(false)
      setXiaomiVerified(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={
        <Button variant="ghost" size="icon" className="rounded-xl border-0 bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-200/80 dark:hover:bg-slate-700/80 transition-all duration-200">
          <Settings className="w-4 h-4 text-slate-600 dark:text-slate-300 stroke-[1.5]" />
        </Button>
      } />

      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-slate-900 dark:text-slate-100 rounded-3xl p-7 shadow-2xl shadow-slate-950/10 relative">
        <DialogHeader className="flex flex-row items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0">
              <Sliders className="w-5 h-5 text-slate-700 dark:text-slate-300 stroke-[1.5]" />
            </div>
            <div>
              <DialogTitle className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                系统偏好设置
              </DialogTitle>
              <DialogDescription className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-normal">
                配置 API 密钥、选择翻译模型与默认声音偏好
              </DialogDescription>
            </div>
          </div>
          <EnvironmentCheckModal
            trigger={
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-xl text-xs gap-1.5 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 stroke-[1.5]" />
                <span>环境诊断</span>
              </Button>
            }
          />
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* 模块一：API 密钥与连接管理 */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-slate-400 stroke-[1.5]" />
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                API 密钥与服务连接
              </h3>
            </div>

            <div className="flex flex-col gap-4">
              {/* AI 翻译 API 密钥与代理设置面板 (第一行，全宽) */}
              <div className="p-4 rounded-2xl bg-slate-50/80 dark:bg-slate-800/40 space-y-3 flex flex-col justify-between transition-all">
                <div className="space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-200/50 dark:border-slate-700/40 pb-2">
                    <Label className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <Languages className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 stroke-[1.5]" />
                      <span>AI 翻译 API 协议与密钥</span>
                      {geminiVerified && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60 px-1.5 py-0.5 rounded-md">
                          <CheckCircle2 className="w-3 h-3 stroke-[1.5]" /> 已校验通过
                        </span>
                      )}
                    </Label>
                  </div>

                  {/* 常用服务预设快捷填入 */}
                  <div className="space-y-1.5 bg-white/60 dark:bg-slate-900/60 p-2.5 rounded-xl border border-slate-200/60 dark:border-slate-800/60">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1">
                        <Zap className="w-3 h-3 text-purple-600 dark:text-purple-400" />
                        主流模型一键预设:
                      </span>
                      <span className="text-[10px] text-slate-400 dark:text-slate-500">
                        点击一键载入协议、Base URL 与模型
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {AI_PRESETS.map((preset) => {
                        const LogoComponent = preset.logo
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => {
                              setSettings((s) => ({
                                ...s,
                                geminiApiFormat: preset.format,
                                geminiApiUrl: preset.baseUrl,
                                geminiModel: preset.defaultModel,
                              }))
                              setGeminiVerified(false)
                              setGeminiResult({
                                type: 'success',
                                message: `已载入【${preset.name}】预设 (协议: ${preset.format}, 默认模型: ${preset.defaultModel})`,
                              })
                            }}
                            className="px-2.5 py-1 text-xs font-medium rounded-lg bg-slate-100/90 dark:bg-slate-800/90 hover:bg-purple-100 dark:hover:bg-purple-950/60 text-slate-700 dark:text-slate-300 hover:text-purple-600 dark:hover:text-purple-400 border border-slate-200/80 dark:border-slate-700/80 transition-all cursor-pointer flex items-center gap-1.5 shadow-2xs"
                          >
                            <LogoComponent className="w-3.5 h-3.5 shrink-0" />
                            <span>{preset.name}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* 1. API 协议格式下拉菜单 (独占一行) */}
                  <div className="space-y-1">
                    <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500">
                      API 协议格式
                    </span>
                    <Select
                      value={settings.geminiApiFormat || 'Gemini'}
                      onValueChange={(val) => {
                        const updatedFmt = val as 'Gemini' | 'OpenAI' | 'OpenAI-Response' | 'Anthropic'
                        setSettings(s => ({ ...s, geminiApiFormat: updatedFmt }))
                        setGeminiVerified(false)
                        setGeminiResult(null)
                      }}
                    >
                      <SelectTrigger className="h-9.5 px-3 text-xs bg-slate-100/80 dark:bg-slate-900/80 border-0 rounded-xl cursor-pointer">
                        <SelectValue placeholder="选择 API 协议格式" />
                      </SelectTrigger>
                      <SelectContent className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-xl">
                        <SelectItem value="OpenAI" className="text-xs cursor-pointer font-medium">OpenAI</SelectItem>
                        <SelectItem value="OpenAI-Response" className="text-xs cursor-pointer font-medium">OpenAI-Response</SelectItem>
                        <SelectItem value="Gemini" className="text-xs cursor-pointer font-medium text-blue-600 dark:text-blue-400">Gemini (预设)</SelectItem>
                        <SelectItem value="Anthropic" className="text-xs cursor-pointer font-medium">Anthropic</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* 2. 自定义 Base URL 输入框 (独占一行全宽) */}
                  <div className="space-y-1">
                    <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500">
                      自定义 Base URL 地址 (留空即使用官方默认)
                    </span>
                    <Input
                      type="text"
                      placeholder={
                        settings.geminiApiFormat === 'OpenAI' || settings.geminiApiFormat === 'OpenAI-Response'
                          ? 'https://api.openai.com'
                          : settings.geminiApiFormat === 'Anthropic'
                          ? 'https://api.anthropic.com'
                          : 'https://generativelanguage.googleapis.com'
                      }
                      value={settings.geminiApiUrl || ''}
                      onChange={(e) => {
                        setSettings(s => ({ ...s, geminiApiUrl: e.target.value }))
                        setGeminiVerified(false)
                        setGeminiResult(null)
                      }}
                      className="h-9.5 bg-slate-100/70 dark:bg-slate-900/80 border-0 rounded-xl text-xs font-mono text-slate-800 dark:text-slate-200 focus-visible:bg-white dark:focus-visible:bg-slate-900 transition-all"
                    />
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 font-mono pt-1 break-all leading-relaxed">
                      预览请求地址：<span className="text-slate-600 dark:text-slate-300 font-medium">{getApiPreviewUrl(settings.geminiApiFormat, settings.geminiApiUrl, settings.geminiModel)}</span>
                    </p>
                  </div>

                  {/* 3. API Key 输入框 (独占一行全宽) */}
                  <div className="space-y-1">
                    <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500">
                      API 密钥 (Key)
                    </span>
                    <div className="relative">
                      <Input
                        id="gemini-key"
                        type={showGeminiKey ? 'text' : 'password'}
                        placeholder="输入 API Key"
                        value={settings.geminiApiKey}
                        onChange={(e) => {
                          setSettings(s => ({ ...s, geminiApiKey: e.target.value }))
                          setGeminiVerified(false)
                          setGeminiResult(null)
                        }}
                        className="h-9.5 bg-slate-100/70 dark:bg-slate-900/80 border-0 rounded-xl pr-10 text-xs font-mono text-slate-800 dark:text-slate-200 focus-visible:bg-white dark:focus-visible:bg-slate-900 transition-all"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        type="button"
                        onClick={() => setShowGeminiKey(!showGeminiKey)}
                        className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 h-7 w-7 rounded-lg"
                      >
                        {showGeminiKey ? <EyeOff className="w-3.5 h-3.5 stroke-[1.5]" /> : <Eye className="w-3.5 h-3.5 stroke-[1.5]" />}
                      </Button>
                    </div>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 pt-0.5">
                      多个密钥使用逗号分隔
                    </p>
                  </div>
                </div>

                <div className="space-y-1.5 pt-1 border-t border-slate-200/50 dark:border-slate-700/40">
                  <div className="flex items-center justify-between gap-1 flex-wrap">
                    {(() => {
                      const keyConsole = getApiKeyConsoleUrl(settings.geminiApiUrl, settings.geminiApiFormat)
                      return (
                        <a
                          href={keyConsole.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                        >
                          <ExternalLink className="w-3 h-3 text-slate-400 stroke-[1.5]" />
                          {keyConsole.label}
                        </a>
                      )
                    })()}
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleFetchGeminiModels}
                        disabled={fetchingModels}
                        className="h-7 px-2.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 rounded-lg transition-colors"
                      >
                        {fetchingModels ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin mr-1 text-slate-500 stroke-[1.5]" />
                            拉取中
                          </>
                        ) : (
                          <>
                            <RefreshCcw className="w-3 h-3 mr-1 text-slate-500 stroke-[1.5]" />
                            拉取模型
                          </>
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleTestGemini}
                        disabled={testingGemini}
                        className="h-7 px-2.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 rounded-lg transition-colors"
                      >
                        {testingGemini ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin mr-1 text-slate-500 stroke-[1.5]" />
                            测试中
                          </>
                        ) : (
                          <>
                            <Zap className="w-3 h-3 mr-1 text-slate-500 stroke-[1.5]" />
                            测试 Key
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* 微细内联状态提示 */}
                  {geminiResult && (
                    <div className={`text-[11px] flex items-center gap-1.5 px-1 py-0.5 ${
                      geminiResult.type === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                    }`}>
                      {geminiResult.type === 'success' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 stroke-[1.5]" />
                      ) : (
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 stroke-[1.5]" />
                      )}
                      <span className="truncate">{geminiResult.message}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* 小米 TTS 密钥面板 (第二行，全宽) */}
              <div className="p-4 rounded-2xl bg-slate-50/80 dark:bg-slate-800/40 space-y-3 flex flex-col justify-between transition-all">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label htmlFor="xiaomi-key" className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <span>小米 TTS Key</span>
                      {xiaomiVerified && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60 px-1.5 py-0.5 rounded-md">
                          <CheckCircle2 className="w-3 h-3 stroke-[1.5]" /> 已通过
                        </span>
                      )}
                    </Label>
                  </div>

                  <div className="relative">
                    <Input
                      id="xiaomi-key"
                      type={showXiaomiKey ? 'text' : 'password'}
                      placeholder="输入 小米 TTS API Key"
                      value={settings.xiaomiTtsKey}
                      onChange={(e) => {
                        setSettings(s => ({ ...s, xiaomiTtsKey: e.target.value }))
                        setXiaomiVerified(false)
                        setXiaomiResult(null)
                      }}
                      className="h-10 bg-slate-100/70 dark:bg-slate-900/80 border-0 rounded-xl pr-10 text-xs font-mono text-slate-800 dark:text-slate-200 focus-visible:bg-white dark:focus-visible:bg-slate-900 focus-visible:ring-2 focus-visible:ring-slate-400/30 transition-all"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      onClick={() => setShowXiaomiKey(!showXiaomiKey)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 h-8 w-8 rounded-lg"
                    >
                      {showXiaomiKey ? <EyeOff className="w-3.5 h-3.5 stroke-[1.5]" /> : <Eye className="w-3.5 h-3.5 stroke-[1.5]" />}
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between gap-1">
                    <a
                      href="https://platform.xiaomimimo.com/console/api-keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
                    >
                      <ExternalLink className="w-3 h-3 text-slate-400 stroke-[1.5]" />
                      获取 Key
                    </a>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleTestXiaomi}
                        disabled={testingXiaomi}
                        className="h-7 px-2.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 rounded-lg transition-colors"
                      >
                        {testingXiaomi ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin mr-1 text-slate-500 stroke-[1.5]" />
                            测试中
                          </>
                        ) : (
                          <>
                            <Zap className="w-3 h-3 mr-1 text-slate-500 stroke-[1.5]" />
                            测试 Key
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* 小米 TTS 微细内联状态提示 */}
                  {xiaomiResult && (
                    <div className={`text-[11px] flex items-center gap-1.5 px-1 py-0.5 ${
                      xiaomiResult.type === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                    }`}>
                      {xiaomiResult.type === 'success' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 stroke-[1.5]" />
                      ) : (
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 stroke-[1.5]" />
                      )}
                      <span className="truncate">{xiaomiResult.message}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* 模块二：默认配置与偏好设置（双行设计） */}
          <div className="space-y-4 pt-4 border-t border-slate-100 dark:border-slate-800/60">
            {/* 行一：Gemini 翻译模型 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Languages className="w-3.5 h-3.5 text-slate-400 stroke-[1.5]" />
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  AI 翻译模型偏好
                </h3>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="gemini-model-select" className="text-xs font-medium text-slate-700 dark:text-slate-300">
                      Gemini 默认翻译模型
                    </Label>
                    {settings.customGeminiModels && settings.customGeminiModels.length > 0 && (
                      <span className="text-[10px] text-slate-400 font-normal">
                        已动态加载 ({settings.customGeminiModels.length})
                      </span>
                    )}
                  </div>
                  <Select
                    value={settings.geminiModel || 'gemini-2.0-flash'}
                    onValueChange={(val) => setSettings(s => ({ ...s, geminiModel: val || 'gemini-2.0-flash' }))}
                  >
                    <SelectTrigger id="gemini-model-select" className="w-full h-10 bg-slate-100/70 dark:bg-slate-800/80 border-0 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-slate-400/30">
                      <SelectValue placeholder="选择 Gemini 翻译模型" />
                    </SelectTrigger>
                    <SelectContent>
                      {settings.customGeminiModels && settings.customGeminiModels.length > 0 ? (
                        <SelectGroup>
                          <SelectLabel>已在线拉取的 Gemini 模型</SelectLabel>
                          {settings.customGeminiModels.map(m => (
                            <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>
                          ))}
                        </SelectGroup>
                      ) : (
                        <SelectGroup>
                          <SelectLabel>预设 Gemini 模型</SelectLabel>
                          {DEFAULT_GEMINI_MODELS.map(m => (
                            <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            {/* 行二：TTS 配音与目标语言偏好 */}
            <div className="space-y-2 pt-2">
              <div className="flex items-center gap-2">
                <Mic className="w-3.5 h-3.5 text-slate-400 stroke-[1.5]" />
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  TTS 语音合成与目标语言
                </h3>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* TTS 语音 */}
                <div className="space-y-1.5">
                  <Label htmlFor="voice-select" className="text-xs font-medium text-slate-700 dark:text-slate-300">
                    TTS 默认音色
                  </Label>
                  <Select value={settings.mimoVoice} onValueChange={(val) => setSettings(s => ({ ...s, mimoVoice: val || '冰糖' }))}>
                    <SelectTrigger id="voice-select" className="w-full h-10 bg-slate-100/70 dark:bg-slate-800/80 border-0 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-slate-400/30">
                      <SelectValue placeholder="选择配音角色" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>中文语音</SelectLabel>
                        {VOICES.filter(v => v.lang === 'zh').map(v => (
                          <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                        ))}
                      </SelectGroup>
                      <SelectGroup>
                        <SelectLabel>English Voices</SelectLabel>
                        {VOICES.filter(v => v.lang === 'en').map(v => (
                          <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                {/* 默认目标语言 */}
                <div className="space-y-1.5">
                  <Label htmlFor="target-lang" className="text-xs font-medium text-slate-700 dark:text-slate-300">
                    默认目标语言
                  </Label>
                  <Select value={settings.targetLang} onValueChange={(val) => setSettings(s => ({ ...s, targetLang: val || 'zh' }))}>
                    <SelectTrigger id="target-lang" className="w-full h-10 bg-slate-100/70 dark:bg-slate-800/80 border-0 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-slate-400/30">
                      <SelectValue placeholder="选择目标语言" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="zh">中文</SelectItem>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="ja">日本語</SelectItem>
                      <SelectItem value="ko">한국어</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            {/* 行三：合成原声音量调节与静音 */}
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {(settings.originalAudioVolume ?? 0.2) > 0 ? (
                    <Volume2 className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 stroke-[1.5]" />
                  ) : (
                    <VolumeX className="w-3.5 h-3.5 text-rose-500 stroke-[1.5]" />
                  )}
                  <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                    视频原声保留音量 (Original Audio Volume)
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-semibold text-slate-700 dark:text-slate-300">
                    {(settings.originalAudioVolume ?? 0.2) <= 0
                      ? '已静音 (0%)'
                      : `${Math.round((settings.originalAudioVolume ?? 0.2) * 100)}%`}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setSettings((s) => ({
                        ...s,
                        originalAudioVolume: (s.originalAudioVolume ?? 0.2) > 0 ? 0.0 : 0.2,
                      }))
                    }
                    className={`h-6 px-2 text-[11px] font-medium rounded-lg transition-colors ${
                      (settings.originalAudioVolume ?? 0.2) <= 0
                        ? 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {(settings.originalAudioVolume ?? 0.2) > 0 ? '静音原声' : '开启原声 (20%)'}
                  </Button>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800/80 space-y-2">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setSettings((s) => ({ ...s, originalAudioVolume: 0.0 }))}
                    title="彻底关掉/静音原声 (0%)"
                    className="p-0.5 rounded text-slate-400 hover:text-rose-500 transition-colors shrink-0 border-0 bg-transparent cursor-pointer"
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
                      setSettings((s) => ({ ...s, originalAudioVolume: val }))
                    }}
                    className="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-600 dark:accent-purple-400"
                  />
                  <button
                    type="button"
                    onClick={() => setSettings((s) => ({ ...s, originalAudioVolume: 1.0 }))}
                    title="设置为最大原声音量 (100%)"
                    className="p-0.5 rounded text-slate-400 hover:text-purple-600 transition-colors shrink-0 border-0 bg-transparent cursor-pointer"
                  >
                    <Volume2 className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  调整合成视频中源音轨（如英文原音）的混音保留音量。设置为 0% 即彻底关闭原音，仅保留译文配音。
                </p>
              </div>
            </div>

            {/* 行四：视频转译与播放体验模式 */}
            <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800/60">
              <div className="flex items-center gap-2">
                <Zap className="w-3.5 h-3.5 text-purple-500 stroke-[1.5]" />
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  视频转译与播放体验模式 (Playback Engine)
                </h3>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* 模式一：极速流式秒开 */}
                <div
                  role="radio"
                  tabIndex={0}
                  aria-checked={(settings.streamMode || 'streaming') === 'streaming'}
                  onClick={() => setSettings(s => ({ ...s, streamMode: 'streaming' }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSettings(s => ({ ...s, streamMode: 'streaming' }))
                    }
                  }}
                  className={`p-3 rounded-xl border transition-all cursor-pointer flex flex-col justify-between outline-none focus-visible:ring-2 focus-visible:ring-purple-500/50 ${
                    (settings.streamMode || 'streaming') === 'streaming'
                      ? 'bg-purple-50/70 dark:bg-purple-950/40 border-purple-500/80 shadow-xs ring-1 ring-purple-500/30'
                      : 'bg-slate-50/50 dark:bg-slate-800/40 border-slate-200/80 dark:border-slate-700/60 hover:bg-slate-100/70'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-xs text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                        <Zap className="w-3.5 h-3.5 text-amber-500 fill-amber-500/20 shrink-0" />
                        <span>极速流式秒开 (边缓存边看)</span>
                      </span>
                      <span className="text-[10px] font-bold text-purple-600 dark:text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded-md border border-purple-500/20">
                        推荐
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                      任务启动 5~10 秒内优先生成首段切片即刻秒开开播，后台如腾讯视频/爱奇艺般实时无感增量缓冲全片。
                    </p>
                  </div>
                </div>

                {/* 模式二：全量沉浸渲染 */}
                <div
                  role="radio"
                  tabIndex={0}
                  aria-checked={settings.streamMode === 'batch'}
                  onClick={() => setSettings(s => ({ ...s, streamMode: 'batch' }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSettings(s => ({ ...s, streamMode: 'batch' }))
                    }
                  }}
                  className={`p-3 rounded-xl border transition-all cursor-pointer flex flex-col justify-between outline-none focus-visible:ring-2 focus-visible:ring-purple-500/50 ${
                    settings.streamMode === 'batch'
                      ? 'bg-purple-50/70 dark:bg-purple-950/40 border-purple-500/80 shadow-xs ring-1 ring-purple-500/30'
                      : 'bg-slate-50/50 dark:bg-slate-800/40 border-slate-200/80 dark:border-slate-700/60 hover:bg-slate-100/70'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-xs text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                        <Shield className="w-3.5 h-3.5 text-blue-500 fill-blue-500/20 dark:text-blue-400 shrink-0" />
                        <span>全量沉浸渲染 (处理完再看)</span>
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                      静默等待后台将全片字幕、配音与画质 100% 完全合成完毕后再开启播放，适合长视频离线导出与静默归档。
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 底部保存操作栏 */}
        <div className="pt-4 border-t border-slate-100 dark:border-slate-800/60 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <a
              href="https://github.com/deijing/shiyibao"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 transition-colors"
            >
              <GithubIcon className="w-4 h-4 text-slate-700 dark:text-slate-300" />
              <span>GitHub 开源仓库</span>
              <ExternalLink className="w-3.5 h-3.5 opacity-60" />
            </a>
            <span className="text-slate-300 dark:text-slate-700">|</span>
            <ChangelogModal />
          </div>

          <div className="flex items-center gap-2.5">
            <DialogClose render={
              <Button variant="ghost" className="h-10 px-5 rounded-xl bg-slate-100/80 dark:bg-slate-800 hover:bg-slate-200/80 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-medium transition-all">
                取消
              </Button>
            } />
            <DialogClose render={
              <Button
                onClick={() => saveSettings(settings)}
                className="h-10 px-7 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-white text-xs font-medium transition-all shadow-sm shadow-slate-900/10"
              >
                保存偏好设置
              </Button>
            } />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
