import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Loader2, Play, ShieldCheck } from 'lucide-react'
import { getThumbnailUrl } from '@/lib/api'
import { formatMediaDuration, resolveAssetUrl, type CampaignSummary, type SampleItem } from '@/lib/agent-api'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export function WaveformBars({ active = true }: { active?: boolean }) {
  return (
    <span className={`sail-wave ${active ? '' : 'is-paused'}`} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  )
}

/** 由字符串得到稳定的伪随机序列，让每个项目的占位封面各不相同但每次渲染一致。 */
function seededRandom(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
}

const WAVE_BARS = 22

/** 没有可用画面时的「声纹海报」：海蓝光晕 + 声波纹路 + 毛玻璃播放钮。 */
function ThumbnailPoster({ seed, format }: { seed: string; format?: string }) {
  const rand = seededRandom(seed)
  const glowX = 15 + rand() * 70
  const glowY = 10 + rand() * 50
  const accentX = 100 - glowX
  const bars = Array.from({ length: WAVE_BARS }, (_, i) => {
    // 中间高、两端低的包络，叠加随机起伏，像一段人声波形
    const envelope = Math.sin((Math.PI * (i + 0.5)) / WAVE_BARS)
    return Math.max(0.12, envelope * (0.35 + rand() * 0.65))
  })

  return (
    <div
      className="sail-thumb-poster"
      style={{
        ['--glow-x' as string]: `${glowX}%`,
        ['--glow-y' as string]: `${glowY}%`,
        ['--accent-x' as string]: `${accentX}%`,
      }}
      aria-hidden="true"
    >
      <span className="sail-thumb-wave">
        {bars.map((h, i) => (
          <span key={i} style={{ height: `${Math.round(h * 100)}%` }} />
        ))}
      </span>
      <span className="sail-thumb-play">
        <Play className="w-2.5 h-2.5 translate-x-[0.5px]" fill="currentColor" strokeWidth={0} />
      </span>
      {format && <span className="sail-thumb-format">{format}</span>}
    </div>
  )
}

function fileFormat(filename?: string | null) {
  const ext = filename?.split('.').pop()
  return ext && ext !== filename && ext.length <= 4 ? ext.toUpperCase() : undefined
}

export function CampaignThumbnail({
  item,
}: {
  item: CampaignSummary
  /** @deprecated 国旗已在卡片信息行展示，封面不再重复 */
  marketFlags?: string
}) {
  const [imgFailed, setImgFailed] = useState(false)
  const src = item.poster
    ? resolveAssetUrl(item.poster)
    : item.cover
      ? resolveAssetUrl(item.cover)
      : item.preview_task_id
        ? getThumbnailUrl(item.preview_task_id)
        : null
  const durationLabel = formatMediaDuration(item.source_duration)
  const hasImage = Boolean(src) && !imgFailed

  return (
    <div className="sail-thumb-box group-hover:border-[var(--sail-blue)] transition-colors">
      {hasImage ? (
        <>
          <img
            src={src!}
            alt={item.source_title || item.source_filename || '项目视频封面'}
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent pointer-events-none" />
        </>
      ) : (
        <ThumbnailPoster seed={item.id} format={fileFormat(item.source_filename)} />
      )}
      {durationLabel && (
        <span className="sail-tabular absolute right-1 bottom-1 px-1 py-0.5 rounded bg-black/70 text-[10px] font-medium leading-none text-white">
          {durationLabel}
        </span>
      )}
    </div>
  )
}

interface SampleShowcaseProps {
  samples: SampleItem[]
  selectedSampleId?: string | null
  busySampleId?: string | null
  /** 首页正在上传/创建会话时锁住样片操作，避免两条流程竞争跳转 */
  locked?: boolean
  onLoadSample: (sample: SampleItem) => void
  onQuickLaunchSample: (sample: SampleItem) => void
}

export function SampleShowcase({
  samples,
  selectedSampleId,
  busySampleId,
  locked = false,
  onLoadSample,
  onQuickLaunchSample,
}: SampleShowcaseProps) {
  const [previewSample, setPreviewSample] = useState<SampleItem | null>(null)
  const [variant, setVariant] = useState<'dubbed' | 'source'>('source')
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const pendingSyncRef = useRef<{ time: number; autoPlay: boolean } | null>(null)

  const openCompare = (sample: SampleItem, initialVariant: 'dubbed' | 'source' = 'source') => {
    setPreviewSample(sample)
    setVariant(initialVariant)
    setCurrentTime(0)
    setPlaying(false)
    pendingSyncRef.current = { time: 0, autoPlay: true }
  }

  const switchVariant = (next: 'dubbed' | 'source') => {
    if (next === variant) return
    const el = videoRef.current
    const resumeTime = el ? el.currentTime : 0
    const wasPlaying = el ? !el.paused && !el.ended : true
    pendingSyncRef.current = { time: resumeTime, autoPlay: wasPlaying }
    setVariant(next)
  }

  const handleLoadedMetadata = () => {
    const el = videoRef.current
    const sync = pendingSyncRef.current
    if (!el || !sync) return
    pendingSyncRef.current = null
    if (sync.time > 0 && Number.isFinite(el.duration)) {
      el.currentTime = Math.min(sync.time, Math.max(0, el.duration - 0.1))
    }
    if (sync.autoPlay) {
      el.play().catch(() => {
        /* 浏览器自动播放受限时保持静音或等待点击 */
      })
    }
  }

  useEffect(() => {
    if (!previewSample) {
      setPlaying(false)
      setCurrentTime(0)
    }
  }, [previewSample])

  if (samples.length === 0) return null

  const activeVideoUrl = previewSample
    ? variant === 'dubbed'
      ? previewSample.dubbed_video_url
      : previewSample.source_video_url
    : ''

  return (
    <section aria-label="文化传播样片体验">
      <div className="sail-section-head">
        <div>
          <h2>文化样片 · 免上传体验</h2>
          <p>建盏英语、宋代点茶日语与中国剪纸韩语，点开即可对比中文原声与 MiMo 译配</p>
        </div>
        <span className="hidden sm:inline text-xs text-muted-foreground sail-tabular shrink-0">
          {samples.length} 组选段 · 已校对台词
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {samples.map((sample) => {
          const isSelected = selectedSampleId === sample.id
          const isBusy = busySampleId === sample.id
          const durationText = formatMediaDuration(sample.duration)
          return (
            <article
              key={sample.id}
              className={`sail-sample-card group ${isSelected ? 'is-selected' : ''}`}
            >
              <button
                type="button"
                onClick={() => openCompare(sample, 'source')}
                className="sail-poster-stage text-left cursor-pointer"
                aria-label={`预览样片：${sample.title}`}
              >
                <img src={sample.poster} alt={sample.title} loading="lazy" />
                <div className="sail-poster-scrim" />

                <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between gap-1.5">
                  <span className="sail-glass-pill truncate">{sample.tag}</span>
                  <span className="sail-glass-pill shrink-0">
                    {sample.dub_label.split(' · ')[0]}
                  </span>
                </div>

                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="w-10 h-10 rounded-full bg-white/90 text-[#0b4f8a] flex items-center justify-center shadow-lg transition-transform duration-200 group-hover:scale-110">
                    <Play className="w-4 h-4 fill-current ml-0.5" />
                  </span>
                </div>

                <div className="absolute bottom-2.5 left-2.5 right-2.5 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.7)]">
                    <WaveformBars active={false} />
                    <span>试看 原声 ⇄ 译配</span>
                  </span>
                  <span className="sail-tabular px-1.5 py-0.5 rounded bg-black/70 text-[11px] font-semibold text-white">
                    {durationText} · {sample.height}p
                  </span>
                </div>
              </button>

              <div className="px-4 pt-3.5 pb-3 flex-1 flex flex-col justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold leading-snug line-clamp-1">{sample.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground line-clamp-2">
                    {sample.highlight}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-[var(--sail-rule)]/70">
                  <a
                    href={sample.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-muted-foreground hover:text-[var(--sail-blue)] truncate"
                    title={sample.source_title}
                  >
                    原作 {sample.source_author} · B 站 ↗
                  </a>
                  <button
                    type="button"
                    disabled={locked || !!busySampleId}
                    onClick={() => onLoadSample(sample)}
                    className={`sail-text-link !text-xs ${isSelected ? 'is-done' : ''}`}
                  >
                    {isBusy ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> 载入中
                      </>
                    ) : isSelected ? (
                      <>
                        <Check className="w-3.5 h-3.5" /> 已载入
                      </>
                    ) : (
                      <>
                        用这条体验 <ArrowRight className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </article>
          )
        })}
      </div>

      <Dialog open={!!previewSample} onOpenChange={(open) => !open && setPreviewSample(null)}>
        <DialogContent className="sm:max-w-5xl p-5 sm:p-6 bg-[var(--sail-panel)] border-[var(--sail-rule)] text-foreground max-h-[92vh] overflow-y-auto">
          {previewSample && (
            <div className="space-y-4">
              <DialogHeader className="pr-8">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <span className="text-xs font-semibold text-[var(--sail-blue)]">
                      {previewSample.tag} · 原声与预制译配对比
                    </span>
                    <DialogTitle className="text-lg font-bold mt-0.5">
                      {previewSample.title}
                    </DialogTitle>
                  </div>

                  <div className="sail-ab-switch" role="tablist" aria-label="切换原声与译配版本">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={variant === 'source'}
                      onClick={() => switchVariant('source')}
                      className={`sail-ab-btn ${variant === 'source' ? 'is-active' : ''}`}
                    >
                      🇨🇳 中文原片
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={variant === 'dubbed'}
                      onClick={() => switchVariant('dubbed')}
                      className={`sail-ab-btn ${variant === 'dubbed' ? 'is-active' : ''}`}
                    >
                      {previewSample.dub_label}
                    </button>
                  </div>
                </div>
                <DialogDescription className="text-xs text-muted-foreground">
                  切换标签可在同一时间点比对中文原声与 MiMo 译配；点击右侧台词可跳转对应画面。预制译配用于快速试听，载入后可生成自己的版本。
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 lg:grid-cols-[1.18fr_0.92fr] items-start">
                <div className="space-y-2.5">
                  <div className="relative rounded-2xl overflow-hidden bg-black border border-[var(--sail-rule)] aspect-video shadow-md">
                    <video
                      ref={videoRef}
                      src={activeVideoUrl}
                      poster={previewSample.poster}
                      controls
                      playsInline
                      onLoadedMetadata={handleLoadedMetadata}
                      onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                      onPlay={() => setPlaying(true)}
                      onPause={() => setPlaying(false)}
                      onEnded={() => setPlaying(false)}
                      className="w-full h-full object-contain"
                    />
                    <div className="absolute top-3 left-3 pointer-events-none">
                      <span className="sail-glass-pill">
                        <WaveformBars active={playing} />
                        <span>
                          {variant === 'dubbed' ? previewSample.dub_label : '🇨🇳 中文原片原声'}
                        </span>
                      </span>
                    </div>
                  </div>
                  <div className="rounded-xl bg-[var(--sail-soft)]/80 border border-[var(--sail-rule)] px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs">
                    <span className="flex items-center gap-1.5 text-muted-foreground min-w-0">
                      <ShieldCheck className="w-4 h-4 text-[var(--sail-blue)] shrink-0" />
                      <span className="truncate">{previewSample.highlight}</span>
                    </span>
                    <span className="sail-tabular text-muted-foreground shrink-0">
                      {previewSample.width}×{previewSample.height} · {formatMediaDuration(previewSample.duration)}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">双语台词与文化译法（点击跳播）</span>
                    <span className="sail-tabular">共 {previewSample.segments.length} 句</span>
                  </div>
                  <div className="grid gap-2 max-h-[340px] overflow-y-auto pr-1">
                    {previewSample.segments.map((seg) => {
                      const active = currentTime >= seg.start && currentTime <= seg.end
                      return (
                        <button
                          key={seg.index}
                          type="button"
                          onClick={() => {
                            if (!videoRef.current) return
                            videoRef.current.currentTime = seg.start
                            videoRef.current.play().catch(() => {})
                          }}
                          className={`w-full text-left rounded-xl border p-3 transition-colors cursor-pointer ${
                            active
                              ? 'border-[var(--sail-blue)] bg-[var(--sail-soft)]'
                              : 'border-[var(--sail-rule)] hover:border-[var(--sail-blue)]/50'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground sail-tabular">
                            <span>
                              #{seg.index + 1} · {formatMediaDuration(seg.start)} – {formatMediaDuration(seg.end)}
                            </span>
                            {seg.translation_note && (
                              <span className="px-2 py-0.5 rounded-full bg-[var(--sail-red)]/12 text-[var(--sail-red)] font-semibold">
                                文化译法
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{seg.source_text}</p>
                          <p className="mt-1 text-xs sm:text-sm font-medium text-[var(--sail-blue)] leading-snug">
                            → {seg.dubbed_text}
                          </p>
                          {seg.translation_note && (
                            <p className="mt-1.5 text-[11px] text-[var(--sail-red)] flex items-start gap-1">
                              <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                              <span>{seg.translation_note}</span>
                            </p>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2.5 pt-3 border-t border-[var(--sail-rule)]">
                <p className="text-xs text-muted-foreground">
                  原作：<a href={previewSample.source_url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{previewSample.source_author} · B 站原片 ↗</a>。已内置原声与校对台词，可直接进入出海规划
                </p>
                <div className="flex flex-wrap items-center gap-2.5 ml-auto">
                  <button
                    type="button"
                    disabled={locked || !!busySampleId}
                    onClick={() => {
                      const chosen = previewSample
                      setPreviewSample(null)
                      onLoadSample(chosen)
                    }}
                    className="sail-ghost !px-4 !py-2 !text-xs"
                  >
                    载入到工作台（自定义需求）
                  </button>
                  <button
                    type="button"
                    disabled={locked || !!busySampleId}
                    onClick={() => {
                      const chosen = previewSample
                      setPreviewSample(null)
                      onQuickLaunchSample(chosen)
                    }}
                    className="sail-primary !py-2 !px-4 !text-xs"
                  >
                    {busySampleId === previewSample.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        免上传 · 直接生成出海方案 <ArrowRight className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
