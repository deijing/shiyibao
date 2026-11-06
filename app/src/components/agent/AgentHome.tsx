import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Compass,
  Globe2,
  Languages,
  Link2,
  Loader2,
  Megaphone,
  Mic2,
  Paperclip,
  Play,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react'
import { createTaskFromUrl, uploadVideo } from '@/lib/api'
import { SecurityGuardNotice } from '../SecurityGuard'
import {
  createCampaign,
  formatMediaDuration,
  formatRelativeTime,
  listCampaigns,
  listMarkets,
  listSamples,
  materializeSample,
  type CampaignSummary,
  type MarketInfo,
  type MaterializedSample,
  type SampleItem,
} from '@/lib/agent-api'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CampaignThumbnail, SampleShowcase } from './SampleShowcase'

const EXAMPLE_PROMPTS = [
  {
    label: '电商 · 日本合规',
    text: '把这条保温杯视频做成 TikTok 日本版，面向 25-35 岁上班族女性，语气温柔，帮我检查有没有违反日本广告法的说法。',
  },
  {
    label: '数码 · 欧美多市场',
    text: '这条产品视频要同时上美国亚马逊和德国市场，各给我 3 个标题和一组标签，品牌名「LumiBar」不要翻译。',
  },
  {
    label: '非遗 · 文化出海',
    text: '把这条剪纸非遗视频翻成英文给西方年轻人看，保留「剪纸」等专有名词，并简短解释文化含义。',
  },
]

const STATUS_META: Record<string, { label: string; dot: string }> = {
  planned: { label: '待确认计划', dot: 'bg-sky-500' },
  running: { label: '执行中', dot: 'bg-indigo-500 animate-pulse' },
  awaiting_review: { label: '待人工审核', dot: 'bg-amber-500' },
  security_hold: { label: '安全闸拦截', dot: 'bg-rose-600' },
  complete: { label: '已完成', dot: 'bg-emerald-500' },
  error: { label: '子任务已清理', dot: 'bg-rose-500' },
}

const CAPABILITIES = [
  { icon: Compass, title: '理解需求', desc: '一句话解析目标市场、受众与语气' },
  { icon: Languages, title: '本地化翻译', desc: '按市场生成口语化译文与术语表' },
  { icon: ShieldCheck, title: '合规审核', desc: '对照当地广告法逐句标出风险' },
  { icon: Mic2, title: 'AI 配音成片', desc: '多语种配音、混音与字幕压制' },
  { icon: Megaphone, title: '平台文案', desc: '标题、标签与描述一键生成' },
]

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

interface LocalVideoMeta {
  duration: number
  width: number
  height: number
}

export default function AgentHome() {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLVideoElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null)
  const [localMeta, setLocalMeta] = useState<LocalVideoMeta | null>(null)
  const [loadedSample, setLoadedSample] = useState<{
    sample: SampleItem
    materialized: MaterializedSample
  } | null>(null)
  const [urlOpen, setUrlOpen] = useState(false)
  const [videoUrl, setVideoUrl] = useState('')
  const [previewPlaying, setPreviewPlaying] = useState(false)

  const [prompt, setPrompt] = useState('')
  const [pickedMarkets, setPickedMarkets] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [busySampleId, setBusySampleId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [markets, setMarkets] = useState<MarketInfo[]>([])
  const [samples, setSamples] = useState<SampleItem[]>([])
  const [recent, setRecent] = useState<CampaignSummary[]>([])

  useEffect(() => {
    listMarkets().then(setMarkets).catch(() => setMarkets([]))
    listSamples().then(setSamples).catch(() => setSamples([]))
    listCampaigns().then((items) => setRecent(items.slice(0, 3))).catch(() => setRecent([]))
  }, [])

  useEffect(() => {
    if (!file) {
      setFilePreviewUrl(null)
      setLocalMeta(null)
      return
    }
    const objectUrl = URL.createObjectURL(file)
    setFilePreviewUrl(objectUrl)
    return () => {
      URL.revokeObjectURL(objectUrl)
    }
  }, [file])

  const clearSource = () => {
    setFile(null)
    setLoadedSample(null)
    setVideoUrl('')
    setUrlOpen(false)
    setPreviewPlaying(false)
    setError(null)
  }

  const pickFile = (picked: File | undefined | null) => {
    if (!picked) return
    if (!/\.(mp4|mov|mkv|webm|avi|flv)$/i.test(picked.name)) {
      setError('请选择 MP4 / MOV / MKV / WebM 等视频文件')
      return
    }
    setError(null)
    setLoadedSample(null)
    setUrlOpen(false)
    setVideoUrl('')
    setPreviewPlaying(false)
    setFile(picked)
  }

  const openUrlInput = () => {
    setFile(null)
    setLoadedSample(null)
    setPreviewPlaying(false)
    setUrlOpen(true)
  }

  // 上传/创建会话进行中时不接受样片操作：两条流程都会 navigate，后完成的会把用户带到另一个会话。
  const flowBusy = !!busy || !!busySampleId

  const handleLoadSample = async (sample: SampleItem) => {
    if (flowBusy) return
    setError(null)
    setBusySampleId(sample.id)
    try {
      const materialized = await materializeSample(sample.id)
      setFile(null)
      setUrlOpen(false)
      setVideoUrl('')
      setPreviewPlaying(false)
      setLoadedSample({ sample, materialized })
      setPickedMarkets(sample.markets)
      setPrompt(sample.prompt)
      composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } catch (err) {
      setError(err instanceof Error ? err.message : '载入体验样片失败，请重试')
    } finally {
      setBusySampleId(null)
    }
  }

  const handleQuickLaunchSample = async (sample: SampleItem) => {
    if (flowBusy) return
    setError(null)
    setBusySampleId(sample.id)
    setBusy('正在准备体验样片并生成出海计划…')
    try {
      const materialized =
        loadedSample?.sample.id === sample.id
          ? loadedSample.materialized
          : await materializeSample(sample.id)
      const session = await createCampaign(materialized.task_id, sample.prompt)
      navigate(`/campaign/${session.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动样片体验失败，请重试')
      setBusy(null)
    } finally {
      setBusySampleId(null)
    }
  }

  const toggleMarketQuickPick = (m: MarketInfo) => {
    // 副作用不能放进 setState 的 updater：StrictMode 会调用两次，导致需求文案重复追加。
    const exists = pickedMarkets.includes(m.code)
    setPickedMarkets(exists ? pickedMarkets.filter((c) => c !== m.code) : [...pickedMarkets, m.code])
    if (exists || prompt.includes(m.name)) return
    const trimmed = prompt.trim()
    setPrompt(
      trimmed
        ? `${trimmed}${/[。！!？?]$/.test(trimmed) ? '' : '，'}同步适配${m.name}市场。`
        : `把这条视频做成${m.name}版本（主流平台：${m.platforms.slice(0, 2).join(' / ')}），按当地表达习惯润色并检查广告合规。`,
    )
  }

  const handleSubmit = async () => {
    if (flowBusy) return
    const trimmedUrl = urlOpen ? videoUrl.trim() : ''
    if (!file && !loadedSample && !trimmedUrl) {
      setError('请先上传视频、粘贴视频链接，或选择一个内置样片')
      return
    }
    if (!prompt.trim()) {
      setError('请用一句话描述你的出海需求，或选择目标市场')
      return
    }
    setError(null)
    try {
      let sourceTaskId: string
      if (loadedSample) {
        sourceTaskId = loadedSample.materialized.task_id
      } else if (file) {
        setBusy('正在上传视频 0%')
        const res = await uploadVideo(file, ({ percent }) => setBusy(`正在上传视频 ${percent}%`))
        sourceTaskId = res.task_id
      } else {
        setBusy('正在解析在线视频链接…')
        const res = await createTaskFromUrl(trimmedUrl)
        sourceTaskId = res.task_id
      }
      setBusy('Agent 正在理解需求并制定出海计划…')
      const session = await createCampaign(sourceTaskId, prompt.trim())
      navigate(`/campaign/${session.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败，请重试')
      setBusy(null)
    }
  }

  const togglePreview = () => {
    const el = previewRef.current
    if (!el) return
    if (el.paused) el.play().catch(() => {})
    else el.pause()
  }

  const hasSource = !!file || !!loadedSample || (urlOpen && !!videoUrl.trim())
  const canSubmit = !busy && hasSource && !!prompt.trim()
  const marketByCode = Object.fromEntries(markets.map((m) => [m.code, m]))
  const pickedInfos = pickedMarkets.map((c) => marketByCode[c]).filter(Boolean) as MarketInfo[]
  const activeMarket = pickedInfos.length > 0 ? pickedInfos[pickedInfos.length - 1] : null
  const marketLabel =
    pickedInfos.length === 0
      ? '目标市场'
      : pickedInfos.length <= 2
        ? pickedInfos.map((m) => `${m.flag} ${m.name}`).join('  ')
        : `${pickedInfos.slice(0, 2).map((m) => m.flag).join(' ')} 等 ${pickedInfos.length} 个市场`
  const statusHint = busy
    ? busy
    : !hasSource
      ? '先添加视频'
      : !prompt.trim()
        ? '再写一句需求'
        : `${IS_MAC ? '⌘' : 'Ctrl'} + Enter 生成`

  return (
    <div className="sail-home flex-grow px-4 sm:px-8 pb-14">
      <div className="relative max-w-6xl mx-auto">
        <header className="pt-10 sm:pt-16 text-center">
          <div className="sail-eyebrow">
            <span className="sail-dot" /> AI Agent · 中外视频双向本地化
          </div>
          <h1 className="sail-title sail-title-hero mt-4">
            一句话，让中国故事<span>走向世界</span>，
            <br />
            让世界佳作<span>走进中国</span>
          </h1>
          <p className="sail-subtitle mx-auto mt-4">
            上传原片，说出目标市场。Agent 自动完成译制、合规审查、配音成片与平台文案。
          </p>
        </header>

        {/* 核心输入舱：需求是主角，视频以附件形式挂在输入框上方，工具栏收纳来源与市场 */}
        <div className="mx-auto max-w-[860px] mt-9 sm:mt-11">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept="video/mp4,video/quicktime,video/x-matroska,video/webm"
            onChange={(e) => {
              pickFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />

          <div
            ref={composerRef}
            className={`sail-composer ${dragging ? 'is-dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
            }}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              pickFile(e.dataTransfer.files?.[0])
            }}
          >
            {dragging && (
              <div className="sail-composer-drop">
                <UploadCloud className="w-6 h-6" />
                <span>松开即可添加原视频</span>
              </div>
            )}

            {(file || loadedSample) && (
              <div className="sail-attach">
                <button
                  type="button"
                  onClick={togglePreview}
                  className="sail-attach-media"
                  aria-label={previewPlaying ? '暂停预览' : '播放预览'}
                >
                  <video
                    ref={previewRef}
                    key={loadedSample ? loadedSample.sample.source_video_url : filePreviewUrl ?? 'local'}
                    src={loadedSample ? loadedSample.sample.source_video_url : filePreviewUrl ?? undefined}
                    poster={loadedSample?.sample.poster}
                    playsInline
                    preload="metadata"
                    onPlay={() => setPreviewPlaying(true)}
                    onPause={() => setPreviewPlaying(false)}
                    onEnded={() => setPreviewPlaying(false)}
                    onLoadedMetadata={(e) => {
                      if (file) {
                        const v = e.currentTarget
                        setLocalMeta({ duration: v.duration, width: v.videoWidth, height: v.videoHeight })
                      }
                    }}
                  />
                  {!previewPlaying && (
                    <span className="sail-attach-play">
                      <Play className="w-3 h-3 fill-current ml-px" />
                    </span>
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate">
                    {loadedSample ? loadedSample.sample.title : file?.name}
                  </p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5 sail-tabular">
                    {loadedSample
                      ? [
                          '内置样片',
                          formatMediaDuration(loadedSample.sample.duration),
                          `${loadedSample.sample.height}p`,
                          `${loadedSample.materialized.segment_count} 句已校对台词`,
                        ].join(' · ')
                      : [
                          '本地原片',
                          file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : '',
                          localMeta && localMeta.duration > 0 ? formatMediaDuration(localMeta.duration) : '',
                          localMeta && localMeta.width > 0 ? `${localMeta.width}×${localMeta.height}` : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="移除视频"
                  title="移除视频"
                  disabled={!!busy}
                  onClick={clearSource}
                  className="sail-icon-btn"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {urlOpen && !file && !loadedSample && (
              <div className="sail-attach">
                <span className="sail-attach-icon">
                  <Link2 className="w-4 h-4" />
                </span>
                <input
                  type="url"
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                  placeholder="粘贴 B 站 / 抖音 / YouTube 链接，或整段分享文案"
                  className="sail-attach-input"
                  autoFocus
                />
                <button
                  type="button"
                  aria-label="取消链接"
                  title="取消链接"
                  onClick={clearSource}
                  className="sail-icon-btn"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            <textarea
              ref={promptRef}
              id="sail-prompt"
              aria-label="出海需求"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) {
                  e.preventDefault()
                  void handleSubmit()
                }
              }}
              rows={3}
              maxLength={2000}
              placeholder="描述你的出海需求，例如：把这条视频做成 TikTok 日本版，面向年轻上班族女性，检查广告用语是否符合当地法规"
              className="sail-composer-input"
            />

            <div className="sail-composer-bar">
              <div className="flex items-center gap-1 min-w-0 flex-wrap">
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => fileInputRef.current?.click()}
                  className={`sail-tool ${file ? 'is-active' : ''}`}
                  title="上传本地视频（也可直接拖入输入框）"
                >
                  <Paperclip className="w-4 h-4" />
                  <span className="hidden sm:inline">上传视频</span>
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={openUrlInput}
                  className={`sail-tool ${urlOpen && !file && !loadedSample ? 'is-active' : ''}`}
                  title="粘贴在线视频链接"
                >
                  <Link2 className="w-4 h-4" />
                  <span className="hidden sm:inline">链接</span>
                </button>
                {samples.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      disabled={!!busy}
                      className={`sail-tool ${loadedSample ? 'is-active' : ''}`}
                      title="免上传，使用内置文化样片"
                    >
                      {busySampleId ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                      <span className="hidden sm:inline">样片</span>
                      <ChevronDown className="w-3 h-3 opacity-60" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="!w-80 p-1.5" align="start" sideOffset={8}>
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>免上传 · 已内置原声与校对台词</DropdownMenuLabel>
                        {samples.map((s) => (
                          <DropdownMenuItem
                            key={s.id}
                            disabled={!!busy || !!busySampleId}
                            onClick={() => void handleLoadSample(s)}
                            className="!gap-3 !p-1.5 cursor-pointer"
                          >
                            <span className="sail-thumb-box block !w-16 !rounded-md">
                              <img src={s.poster} alt="" loading="lazy" />
                            </span>
                            <span className="min-w-0">
                              <span className="block text-[13px] font-medium truncate">{s.title}</span>
                              <span className="block text-[11px] text-muted-foreground truncate sail-tabular">
                                {s.dub_label.split(' · ')[0]} · {formatMediaDuration(s.duration)}
                              </span>
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                {markets.length > 0 && (
                  <>
                    <span className="sail-tool-sep" aria-hidden="true" />
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        disabled={!!busy}
                        className={`sail-tool ${pickedInfos.length > 0 ? 'is-active' : ''}`}
                        title="选择目标市场（可多选）"
                      >
                        {pickedInfos.length === 0 && <Globe2 className="w-4 h-4" />}
                        <span className={pickedInfos.length === 0 ? 'hidden sm:inline' : ''}>{marketLabel}</span>
                        <ChevronDown className="w-3 h-3 opacity-60" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="!w-60 p-1.5" align="start" sideOffset={8}>
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>目标市场 · 可多选，自动写入需求</DropdownMenuLabel>
                          {markets.map((m) => (
                            <DropdownMenuCheckboxItem
                              key={m.code}
                              checked={pickedMarkets.includes(m.code)}
                              onCheckedChange={() => toggleMarketQuickPick(m)}
                              className="!py-1.5 cursor-pointer"
                            >
                              <span className="w-5 text-center">{m.flag}</span>
                              <span className="text-[13px]">{m.name}</span>
                              <span className="ml-auto text-[11px] text-muted-foreground truncate max-w-24">
                                {m.platforms[0]}
                              </span>
                            </DropdownMenuCheckboxItem>
                          ))}
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <span className="hidden sm:inline text-xs text-muted-foreground">{statusHint}</span>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className="sail-send"
                  aria-label="生成出海方案"
                  title={canSubmit ? '生成出海方案' : statusHint}
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-[18px] h-[18px]" />}
                </button>
              </div>
            </div>
          </div>

          {error && <p className="mt-3 px-1 text-sm text-[var(--sail-red)]">{error}</p>}

          {activeMarket ? (
            <p className="sail-hint-line">
              <ShieldCheck className="w-3.5 h-3.5 text-[var(--sail-blue)] shrink-0" />
              <span className="font-medium text-foreground shrink-0">
                {activeMarket.flag} {activeMarket.name}
              </span>
              <span className="shrink-0">· {activeMarket.platforms.slice(0, 3).join(' / ')} · {activeMarket.currency}</span>
              <span className="truncate">· 合规重点：{activeMarket.rules[0]}</span>
            </p>
          ) : (
            <div className="sail-hint-line flex-wrap">
              <span className="shrink-0">试试</span>
              {EXAMPLE_PROMPTS.map((example) => (
                <button
                  key={example.label}
                  type="button"
                  onClick={() => {
                    setPrompt(example.text)
                    promptRef.current?.focus()
                  }}
                  className="sail-suggest"
                  title={example.text}
                >
                  {example.label}
                </button>
              ))}
            </div>
          )}

          <SecurityGuardNotice compact className="mt-3 text-left" />
        </div>

        {recent.length > 0 && (
          <section aria-label="最近的出海项目" className="mt-16">
            <div className="sail-section-head">
              <h2>继续最近的项目</h2>
            </div>
            <ul className="grid gap-3 sm:grid-cols-3">
              {recent.map((item) => {
                const flags = item.markets.map((c) => marketByCode[c]?.flag ?? c).join(' ')
                const st = STATUS_META[item.status] ?? { label: item.status, dot: 'bg-slate-400' }
                const mediaLabel = item.source_title || item.source_filename || '原片任务'
                const relTime = formatRelativeTime(item.created_at)
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => navigate(`/campaign/${item.id}`)}
                      className="sail-recent group"
                    >
                      <CampaignThumbnail item={item} />
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block text-[13px] font-semibold truncate">{mediaLabel}</span>
                        <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                          <span>{st.label}</span>
                          {flags && <span>· {flags}</span>}
                          {relTime && <span className="ml-auto sail-tabular">{relTime}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <div className={recent.length > 0 ? 'mt-12' : 'mt-16'}>
          <SampleShowcase
            samples={samples}
            selectedSampleId={loadedSample?.sample.id}
            busySampleId={busySampleId}
            locked={!!busy}
            onLoadSample={(s) => void handleLoadSample(s)}
            onQuickLaunchSample={(s) => void handleQuickLaunchSample(s)}
          />
        </div>

        <section aria-label="Agent 自动化工作流" className="mt-16">
          <div className="sail-section-head">
            <h2>Agent 如何工作</h2>
            <button type="button" onClick={() => navigate('/studio')} className="sail-text-link">
              只需单语种翻译？进入单片精修 <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <ol className="sail-flow">
            {CAPABILITIES.map(({ icon: Icon, title, desc }, i) => (
              <li key={title}>
                <span className="sail-flow-node">
                  <Icon className="w-4 h-4" />
                </span>
                <p className="mt-3 text-[11px] font-semibold tracking-wider text-muted-foreground sail-tabular">
                  STEP {String(i + 1).padStart(2, '0')}
                </p>
                <p className="mt-1 text-sm font-semibold">{title}</p>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{desc}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  )
}
