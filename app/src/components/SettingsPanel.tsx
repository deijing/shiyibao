import { useState, useEffect } from 'react'
import { Settings, Eye, EyeOff, Sliders, KeyRound, Mic, Zap, CheckCircle2, AlertCircle, Loader2, ExternalLink, Sparkles } from 'lucide-react'
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
  geminiModel: string
  xiaomiTtsKey: string
  mimoVoice: string
  sourceLang: string
  targetLang: string
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

  // Standardize raw string formatting
  return modelId
    .split('/')
    .pop()!
    .replace(/^gemini-/i, 'Gemini ')
    .replace(/-/g, ' ')
}

const DEFAULT_SETTINGS: AppSettings = {
  geminiApiKey: '',
  geminiModel: 'gemini-2.0-flash',
  xiaomiTtsKey: '',
  mimoVoice: '冰糖',
  sourceLang: 'auto',
  targetLang: 'zh',
  customGeminiModels: [],
}

export function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) }
  } catch { /* ignore */ }
  return DEFAULT_SETTINGS
}

export function saveSettings(settings: AppSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  saveServerSettings(settings)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('settings-updated'))
  }
}

export default function SettingsPanel() {
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

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  async function handleTestGemini() {
    setTestingGemini(true)
    setGeminiResult(null)
    try {
      const res = await testGeminiKey(settings.geminiApiKey)
      setGeminiVerified(true)
      setGeminiResult({
        type: 'success',
        message: res.message || 'Gemini API Key 校验成功！通信正常。',
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
        message: '请先输入 Gemini API Key 再尝试获取模型列表',
      })
      return
    }
    setFetchingModels(true)
    setGeminiResult(null)
    try {
      const models = await fetchGeminiModels(settings.geminiApiKey)
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
          message: `拉取成功！检索到 ${models.length} 个可用 Gemini 模型。`,
        })
      } else {
        setGeminiResult({
          type: 'error',
          message: '未检索到该 API Key 支持生成能力的 Gemini 模型',
        })
      }
    } catch (err) {
      setGeminiResult({
        type: 'error',
        message: err instanceof Error ? err.message : '获取 Gemini 模型列表失败',
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

  return (
    <Dialog>
      <DialogTrigger>
        <Button variant="ghost" size="icon" className="rounded-xl border-0 bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-200/80 dark:hover:bg-slate-700/80 transition-all duration-200">
          <Settings className="w-4 h-4 text-slate-600 dark:text-slate-300 stroke-[1.5]" />
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-3xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-slate-900 dark:text-slate-100 rounded-3xl p-7 shadow-2xl shadow-slate-950/10 relative">
        <DialogHeader className="flex flex-row items-center gap-3 pb-4 border-b border-slate-100 dark:border-slate-800/60">
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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Gemini Key 面板 */}
              <div className="p-4 rounded-2xl bg-slate-50/80 dark:bg-slate-800/40 space-y-3 flex flex-col justify-between transition-all">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label htmlFor="gemini-key" className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <span>Gemini API Key</span>
                      {geminiVerified && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60 px-1.5 py-0.5 rounded-md">
                          <CheckCircle2 className="w-3 h-3 stroke-[1.5]" /> 已通过
                        </span>
                      )}
                    </Label>
                  </div>

                  <div className="relative">
                    <Input
                      id="gemini-key"
                      type={showGeminiKey ? 'text' : 'password'}
                      placeholder="输入 Gemini API Key"
                      value={settings.geminiApiKey}
                      onChange={(e) => {
                        setSettings(s => ({ ...s, geminiApiKey: e.target.value }))
                        setGeminiVerified(false)
                        setGeminiResult(null)
                      }}
                      className="h-10 bg-slate-100/70 dark:bg-slate-900/80 border-0 rounded-xl pr-10 text-xs font-mono text-slate-800 dark:text-slate-200 focus-visible:bg-white dark:focus-visible:bg-slate-900 focus-visible:ring-2 focus-visible:ring-slate-400/30 transition-all"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      onClick={() => setShowGeminiKey(!showGeminiKey)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 h-8 w-8 rounded-lg"
                    >
                      {showGeminiKey ? <EyeOff className="w-3.5 h-3.5 stroke-[1.5]" /> : <Eye className="w-3.5 h-3.5 stroke-[1.5]" />}
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between gap-1 flex-wrap">
                    <a
                      href="https://aistudio.google.com/api-keys"
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
                            <Sparkles className="w-3 h-3 mr-1 text-slate-500 stroke-[1.5]" />
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

                  {/* Gemini 微细内联状态提示 */}
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

              {/* 小米 TTS Key 面板 */}
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
                <Sparkles className="w-3.5 h-3.5 text-slate-400 stroke-[1.5]" />
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
          </div>
        </div>

        {/* 底部保存操作栏 */}
        <div className="pt-4 border-t border-slate-100 dark:border-slate-800/60 flex items-center justify-end gap-2.5">
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
      </DialogContent>
    </Dialog>
  )
}
