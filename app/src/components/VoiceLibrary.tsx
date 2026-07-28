import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

import {
  Mic,
  Play,
  Loader2,
  Check,
  AudioLines,
  Volume2,
  Radio,
  Waves,
  Search,
  CheckCircle2
} from 'lucide-react'
import { getVoicePreviewUrl } from '@/lib/api'
import { loadSettings, saveSettings, type AppSettings } from './SettingsPanel'
import { Button } from '@/components/ui/button'

interface VoiceInfo {

  id: string
  name: string
  gender: 'female' | 'male'
  lang: 'zh' | 'en'
  categoryLabel: string
  description: string
  tags: string[]
  sampleRate: string
}

const VOICES: VoiceInfo[] = [
  {
    id: '冰糖',
    name: '冰糖',
    gender: 'female',
    lang: 'zh',
    categoryLabel: '日常 / 教程',
    description: '甜美清亮的女声，吐字清晰流畅，极具亲和力，适合日常视频、教学课程与生活类内容。',
    tags: ['甜美', '清亮', '日常教程'],
    sampleRate: '24kHz HD',
  },
  {
    id: '茉莉',
    name: '茉莉',
    gender: 'female',
    lang: 'zh',
    categoryLabel: '文艺 / 旁白',
    description: '温柔优雅的女声，语调细腻富有情感层次，适合文艺短片、品牌叙事与有声读物。',
    tags: ['温柔', '知性', '品牌叙事'],
    sampleRate: '24kHz HD',
  },
  {
    id: '苏打',
    name: '苏打',
    gender: 'male',
    lang: 'zh',
    categoryLabel: '商务 / 科技',
    description: '沉稳干练的商务男声，吐字坚实有力，专为科技评测、商业发布与知识解说打造。',
    tags: ['沉稳', '专业', '商务解说'],
    sampleRate: '24kHz Studio',
  },
  {
    id: '白桦',
    name: '白桦',
    gender: 'male',
    lang: 'zh',
    categoryLabel: '纪录片 / 叙事',
    description: '浑厚磁性的质感男声，具有很强的声场空间感与权威度，适合纪录片、历史解说与高端视听。',
    tags: ['浑厚', '磁性', '高端纪录片'],
    sampleRate: '24kHz Studio',
  },
  {
    id: 'Mia',
    name: 'Mia',
    gender: 'female',
    lang: 'en',
    categoryLabel: 'Tutorials / Casual',
    description: 'Warm and articulated female voice. Delivers information clearly with a smooth, friendly tone for presentations.',
    tags: ['Clear', 'Friendly', 'E-learning'],
    sampleRate: '24kHz HD',
  },
  {
    id: 'Chloe',
    name: 'Chloe',
    gender: 'female',
    lang: 'en',
    categoryLabel: 'Marketing / Corporate',
    description: 'Bright and engaging female tone. Tailored for modern SaaS demos, pitch decks, and brand campaigns.',
    tags: ['Corporate', 'Engaging', 'SaaS Demo'],
    sampleRate: '24kHz Studio',
  },
  {
    id: 'Milo',
    name: 'Milo',
    gender: 'male',
    lang: 'en',
    categoryLabel: 'Enterprise / Tech',
    description: 'Executive male voice with precise diction and neutral tone, suited for enterprise explainer videos and keynotes.',
    tags: ['Executive', 'Professional', 'Tech Keynote'],
    sampleRate: '24kHz Studio',
  },
  {
    id: 'Dean',
    name: 'Dean',
    gender: 'male',
    lang: 'en',
    categoryLabel: 'Narration / Broadcast',
    description: 'Deep, calm, and authoritative narration voice. Excellent for documentaries, audiobooks, and long-form commentary.',
    tags: ['Authoritative', 'Calm', 'Broadcast'],
    sampleRate: '24kHz HD',
  },
]

interface VoiceLibraryProps {
  onSelectVoice?: (voiceId: string) => void
}

export default function VoiceLibrary({ onSelectVoice }: VoiceLibraryProps) {
  const [langFilter, setLangFilter] = useState<'all' | 'zh' | 'en'>('all')
  const [genderFilter, setGenderFilter] = useState<'all' | 'female' | 'male'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [playing, setPlaying] = useState<string | null>(null)
  const [generating, setGenerating] = useState<string | null>(null)
  const [selected, setSelected] = useState(() => loadSettings().mimoVoice)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)

  useEffect(() => {
    function syncSettings() {
      setSelected(loadSettings().mimoVoice)
    }
    window.addEventListener('settings-updated', syncSettings)
    window.addEventListener('storage', syncSettings)
    return () => {
      window.removeEventListener('settings-updated', syncSettings)
      window.removeEventListener('storage', syncSettings)
    }
  }, [])

  const filteredVoices = useMemo(() => {
    return VOICES.filter(v => {
      const matchLang = langFilter === 'all' || v.lang === langFilter
      const matchGender = genderFilter === 'all' || v.gender === genderFilter
      const query = searchQuery.trim().toLowerCase()
      const matchQuery = !query ||
        v.name.toLowerCase().includes(query) ||
        v.description.toLowerCase().includes(query) ||
        v.tags.some(t => t.toLowerCase().includes(query)) ||
        v.categoryLabel.toLowerCase().includes(query)
      return matchLang && matchGender && matchQuery
    })
  }, [langFilter, genderFilter, searchQuery])

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
    setPlaying(null)
  }, [])

  const [errorVoiceId, setErrorVoiceId] = useState<string | null>(null)

  const handlePreview = useCallback(async (voiceId: string) => {
    stopPlayback()
    if (playing === voiceId) return

    setErrorVoiceId(null)
    setGenerating(voiceId)
    try {
      const res = await fetch(getVoicePreviewUrl(voiceId))
      if (!res.ok) throw new Error(`preview failed: status ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      blobUrlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => {
        setPlaying(null)
        audioRef.current = null
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current)
          blobUrlRef.current = null
        }
      }
      audio.onerror = () => {
        setPlaying(null)
        setGenerating(null)
        setErrorVoiceId(voiceId)
      }
      setGenerating(null)
      setPlaying(voiceId)
      await audio.play()
    } catch (err) {
      console.error('TTS Preview Error:', err)
      setGenerating(null)
      setPlaying(null)
      setErrorVoiceId(voiceId)
    }
  }, [playing, stopPlayback])

  const handleSelect = useCallback((voiceId: string) => {
    setSelected(voiceId)
    const updatedSettings: AppSettings = { ...loadSettings(), mimoVoice: voiceId }
    saveSettings(updatedSettings)
    onSelectVoice?.(voiceId)
  }, [onSelectVoice])

  useEffect(() => {
    return () => {
      stopPlayback()
    }
  }, [stopPlayback])



  // 按索引选择图标，丰富单色视觉层次
  const getVoiceIcon = (index: number) => {
    const icons = [AudioLines, Volume2, Waves, Radio]
    const IconComponent = icons[index % icons.length]
    return <IconComponent className="w-5 h-5 text-slate-700 dark:text-slate-300" />
  }

  return (
    <div className="flex-grow flex flex-col px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto py-6 sm:py-8 w-full relative z-10 text-slate-900 dark:text-slate-100 font-sans">
      {/* 头部区域：极简商务 SaaS 风格 */}
      <div className="mb-8 flex flex-col items-center text-center max-w-2xl mx-auto">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-slate-100 dark:bg-slate-800/90 text-slate-600 dark:text-slate-300 text-xs font-semibold tracking-wide border border-slate-200/80 dark:border-slate-700/80 mb-4 shadow-2xs">
          <Mic className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          <span>AI VOICE MATRIX</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-50 mb-3">
          AI 声纹音色库
        </h1>
        <p className="text-slate-500 dark:text-slate-400 text-sm sm:text-base leading-relaxed font-normal">
          提供专业级高保真 AI 语音合成音色。选中音色将即时应用于您的视频转译与多语种配音管线。
        </p>
      </div>

      {/* 控制与筛选工具栏 */}
      <div className="bg-white dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800 rounded-xl p-4 mb-8 shadow-xs flex flex-col md:flex-row items-center justify-between gap-4 w-full">
        {/* 语言/分类分段切换 */}
        <div className="inline-flex p-1 bg-slate-100/90 dark:bg-slate-800/90 rounded-lg border border-slate-200/60 dark:border-slate-700/60 w-full md:w-auto">
          {(['all', 'zh', 'en'] as const).map(lang => (
            <button
              key={lang}
              onClick={() => setLangFilter(lang)}
              className={`flex-1 md:flex-none px-4 py-1.5 text-xs sm:text-sm font-semibold rounded-md transition-all duration-150 cursor-pointer ${
                langFilter === lang
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs border border-slate-200/60 dark:border-slate-700/60'
                  : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {lang === 'all' ? '全部语言' : lang === 'zh' ? '中文音色 (CN)' : 'English Voices (EN)'}
            </button>
          ))}
        </div>

        {/* 搜索与性别筛选组合 */}
        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
          {/* 性别次级筛选 */}
          <div className="inline-flex p-0.5 bg-slate-100/60 dark:bg-slate-800/60 rounded-md border border-slate-200/50 dark:border-slate-700/50">
            {(['all', 'female', 'male'] as const).map(g => (
              <button
                key={g}
                onClick={() => setGenderFilter(g)}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                  genderFilter === g
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs font-semibold'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                {g === 'all' ? '全部' : g === 'female' ? '女声' : '男声'}
              </button>
            ))}
          </div>

          {/* 简易搜索框 */}
          <div className="relative flex-1 md:w-48">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="搜索音色、标签..."
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-600 dark:focus:ring-blue-500 transition-all"
            />
          </div>
        </div>
      </div>

      {/* 结果数量提示 */}
      <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400 mb-5 px-1">
        <span>共匹配 {filteredVoices.length} 款专业音色</span>
        {selected && (
          <span className="inline-flex items-center gap-1.5 text-blue-600 dark:text-blue-400 font-semibold">
            <CheckCircle2 className="w-3.5 h-3.5" /> 当前使用：{selected}
          </span>
        )}
      </div>

      {/* 音色卡片网格 - 保持左右留白 + 一排4个正方形卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-6 pb-12 w-full">
        {filteredVoices.map((voice, index) => {
          const isSelected = selected === voice.id
          const isPlaying = playing === voice.id
          const isGenerating = generating === voice.id
          const isError = errorVoiceId === voice.id

          return (
            <div
              key={voice.id}
              className={`group relative aspect-square rounded-2xl border bg-white dark:bg-slate-900/90 transition-all duration-200 flex flex-col justify-between overflow-hidden p-5 sm:p-6 ${
                isSelected
                  ? 'border-blue-600 dark:border-blue-500 ring-1 ring-blue-600/30 dark:ring-blue-500/30 shadow-[0_4px_24px_-4px_rgba(37,99,235,0.18)]'
                  : 'border-slate-200/80 dark:border-slate-800 shadow-[0_2px_10px_-2px_rgba(15,23,42,0.04)] hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-[0_10px_25px_-5px_rgba(15,23,42,0.08)]'
              }`}
            >
              {/* 黄金比例 上半内容区 (~61.8%) */}
              <div className="flex-[1.618] flex flex-col justify-between overflow-hidden">
                <div>
                  {/* 头部：单色商务图标与标题信息 */}
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-slate-100/90 dark:bg-slate-800/90 border border-slate-200/70 dark:border-slate-700/70 flex items-center justify-center shrink-0 group-hover:bg-slate-200/70 dark:group-hover:bg-slate-700/90 transition-colors">
                        {getVoiceIcon(index)}
                      </div>
                      <div>
                        <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 tracking-tight leading-snug">
                          {voice.name}
                        </h3>
                        <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 uppercase tracking-wider block mt-0.5">
                          {voice.lang === 'zh' ? 'Chinese' : 'English'} • {voice.gender === 'female' ? 'Female' : 'Male'}
                        </span>
                      </div>
                    </div>

                    {/* 选定标志 */}
                    {isSelected && (
                      <span className="shrink-0 inline-flex items-center gap-1 bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200/80 dark:border-blue-800/60 text-[11px] px-2 py-0.5 rounded font-semibold">
                        <Check className="w-3 h-3 stroke-[2.5]" />
                        已选用
                      </span>
                    )}
                  </div>

                  {/* 分类及描述 */}
                  <div className="mb-2">
                    <span className="inline-block text-[11px] font-medium text-slate-500 dark:text-slate-400 bg-slate-100/80 dark:bg-slate-800/70 px-2 py-0.5 rounded border border-slate-200/50 dark:border-slate-700/50">
                      {voice.categoryLabel}
                    </span>
                  </div>

                  <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-normal leading-relaxed line-clamp-2 sm:line-clamp-3">
                    {voice.description}
                  </p>
                </div>
              </div>

              {/* 黄金比例 下半操作与标签区 (~38.2%) */}
              <div className="shrink-0 pt-3 border-t border-slate-100 dark:border-slate-800/80 flex flex-col justify-between gap-3">
                {/* 标签列表 */}
                <div className="flex flex-wrap gap-1.5 overflow-hidden">
                  {voice.tags.map(tag => (
                    <span
                      key={tag}
                      className="text-[11px] px-2.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300 font-medium border border-slate-200/50 dark:border-slate-700/50"
                    >
                      {tag}
                    </span>
                  ))}
                </div>

                {/* 操作栏：水平两端对齐 */}
                <div className="flex items-center justify-between gap-3">
                  <Button
                    variant="ghost"
                    onClick={() => (isPlaying ? stopPlayback() : handlePreview(voice.id))}
                    disabled={isGenerating}
                    className={`h-9 px-3 text-xs font-semibold rounded-lg shrink-0 flex items-center gap-1.5 transition-all duration-150 cursor-pointer border ${
                      isPlaying
                        ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-700'
                        : isError
                        ? 'bg-red-50 dark:bg-red-950/40 border-red-205 dark:border-red-800 text-red-600 dark:text-red-400'
                        : 'bg-slate-50 dark:bg-slate-800/90 border-slate-200/80 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/80'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                    title="试听音色"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600 dark:text-blue-400" />
                        <span>加载中</span>
                      </>
                    ) : isPlaying ? (
                      <>
                        <div className="flex gap-[2px] items-end h-3">
                          <div className="w-0.5 h-3 bg-blue-600 dark:bg-blue-400 animate-pulse"></div>
                          <div className="w-0.5 h-2 bg-blue-600 dark:bg-blue-400 animate-pulse delay-75"></div>
                          <div className="w-0.5 h-3 bg-blue-600 dark:bg-blue-400 animate-pulse delay-150"></div>
                        </div>
                        <span>播放中</span>
                      </>
                    ) : isError ? (
                      <span>重试</span>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>试听</span>
                      </>
                    )}
                  </Button>

                  <Button
                    onClick={() => handleSelect(voice.id)}
                    disabled={isSelected}
                    className={`flex-1 h-9 text-xs sm:text-sm font-semibold transition-all duration-150 rounded-lg cursor-pointer border ${
                      isSelected
                        ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400 border-blue-200/80 dark:border-blue-800/60 pointer-events-none'
                        : 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white border-transparent shadow-xs dark:bg-blue-600 dark:hover:bg-blue-500'
                    } disabled:opacity-100`}
                  >
                    {isSelected ? (
                      <span className="inline-flex items-center gap-1">
                        <Check className="w-3.5 h-3.5 stroke-[2.5]" /> 已应用
                      </span>
                    ) : (
                      '选用音色'
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {filteredVoices.length === 0 && (
        <div className="py-16 text-center bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-xl mb-12">
          <p className="text-slate-400 dark:text-slate-500 text-sm">未找到与筛选条件相符的音色</p>
          <button
            onClick={() => {
              setLangFilter('all')
              setGenderFilter('all')
              setSearchQuery('')
            }}
            className="mt-3 text-xs font-semibold text-blue-600 hover:underline cursor-pointer"
          >
            重置筛选条件
          </button>
        </div>
      )}
    </div>
  )
}
