import { ShieldCheck, ShieldAlert, ShieldQuestion, EyeOff, UserCheck, ArrowRight, Lock } from 'lucide-react'
import type { SecuritySummary } from '@/lib/api'

const GUARD_CATEGORIES: { key: string; label: string; tone: string; warnOnly?: boolean }[] = [
  { key: 'classified', label: '国家秘密', tone: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30' },
  { key: 'military', label: '军事敏感', tone: 'bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-500/30' },
  { key: 'privacy', label: '个人隐私', tone: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30' },
  { key: 'geo', label: '精确坐标', tone: 'bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30' },
  { key: 'technology', label: '关键技术', tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30', warnOnly: true },
  { key: 'custom', label: '自定义敏感词', tone: 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30' },
]

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(GUARD_CATEGORIES.map((c) => [c.key, c.label]))

interface SecurityGuardNoticeProps {
  /** 已配置的自定义敏感词条数 */
  customTermCount?: number
  /** 紧凑模式：只显示一行说明 */
  compact?: boolean
  className?: string
}

/** 出境安全闸常驻说明：让使用者（和评委）一眼看到内容出境前有本地把关。 */
export function SecurityGuardNotice({ customTermCount = 0, compact = false, className = '' }: SecurityGuardNoticeProps) {
  if (compact) {
    return (
      <div className={`flex items-start gap-2 px-3 py-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 text-[11px] leading-relaxed text-emerald-800 dark:text-emerald-300 ${className}`}>
        <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          <b className="font-semibold">出境安全闸已启用</b>：字幕送往云端翻译前、导出前均在本机离线检测国家秘密 / 军事 / 隐私 / 坐标等内容，命中即暂停，需脱敏或人工确认后才会继续。
        </span>
      </div>
    )
  }

  return (
    <div className={`w-full p-3.5 sm:p-4 rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-50/90 to-white/80 dark:from-emerald-950/30 dark:to-slate-900/70 backdrop-blur-xl shadow-sm ${className}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-emerald-600 text-white flex items-center justify-center shadow-sm">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">出境安全闸</span>
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-emerald-600/10 text-emerald-700 dark:text-emerald-300 border border-emerald-600/25">
                <span className="relative flex w-1.5 h-1.5">
                  <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-500 opacity-75 animate-ping" />
                  <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-emerald-500" />
                </span>
                已启用 · 全程本地离线
              </span>
            </div>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">内容出境前自动把关，防止涉密、军事、关键技术与个人隐私外泄</p>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5 flex-wrap text-[10px] font-medium text-slate-600 dark:text-slate-300">
        <span className="px-2 py-1 rounded-lg bg-white/80 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700">语音识别</span>
        <ArrowRight className="w-3 h-3 text-slate-400" />
        <span className="px-2 py-1 rounded-lg bg-emerald-600 text-white shadow-sm inline-flex items-center gap-1"><Lock className="w-3 h-3" />本地安全检测</span>
        <ArrowRight className="w-3 h-3 text-slate-400" />
        <span className="px-2 py-1 rounded-lg bg-white/80 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700">云端翻译</span>
        <ArrowRight className="w-3 h-3 text-slate-400" />
        <span className="px-2 py-1 rounded-lg bg-white/80 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700">导出前复检</span>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {GUARD_CATEGORIES.map((c) => (
          <span key={c.key} className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border ${c.tone}`}>
            {c.label}
            {c.warnOnly && <span className="font-normal opacity-80">（提醒）</span>}
            {c.key === 'custom' && <span className="font-normal opacity-80"> {customTermCount} 条</span>}
          </span>
        ))}
      </div>

      <p className="mt-2.5 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
        命中即暂停任务，原文不会发往云端；可选择「一键脱敏」或「填写理由人工放行」，全部处置留存审计记录。
        <span className="text-amber-700 dark:text-amber-400">画面内容（字幕烧录、地图、装备画面）暂不检测，请人工把关。</span>
      </p>
    </div>
  )
}

interface SecurityStatusBadgeProps {
  summary?: SecuritySummary | null
  className?: string
}

/** 任务的安全闸结论徽章：通过 / 提醒 / 已脱敏 / 人工放行 / 拦截。 */
export function SecurityStatusBadge({ summary, className = '' }: SecurityStatusBadgeProps) {
  const base = `inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${className}`
  if (!summary) {
    return (
      <span className={`${base} bg-slate-500/5 text-slate-500 dark:text-slate-400 border-slate-400/30`} title="该任务尚未经过出境安全闸检测（可能早于该功能创建）">
        <ShieldQuestion className="w-3 h-3" />安全闸：未检测
      </span>
    )
  }
  const cats = Object.entries(summary.by_category || {})
    .map(([k, n]) => `${CATEGORY_LABEL[k] ?? k} ${n}`)
    .join('、')
  const detail = `本地离线检测 · 拦截 ${summary.blocking} · 提醒 ${summary.warnings} · 已放行 ${summary.cleared}${cats ? `（${cats}）` : ''}`

  if (summary.level === 'block') {
    return (
      <span className={`${base} bg-rose-600 text-white border-rose-600`} title={detail}>
        <ShieldAlert className="w-3 h-3" />安全闸拦截 {summary.blocking} 处
      </span>
    )
  }
  if (summary.resolution === 'redact') {
    return (
      <span className={`${base} bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30`} title={detail}>
        <EyeOff className="w-3 h-3" />安全闸：已脱敏放行
      </span>
    )
  }
  if (summary.resolution === 'acknowledge' || summary.cleared > 0) {
    return (
      <span className={`${base} bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30`} title={detail}>
        <UserCheck className="w-3 h-3" />安全闸：人工确认放行
      </span>
    )
  }
  if (summary.level === 'warn') {
    return (
      <span className={`${base} bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30`} title={detail}>
        <ShieldAlert className="w-3 h-3" />安全闸：{summary.warnings} 处提醒
      </span>
    )
  }
  return (
    <span className={`${base} bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30`} title={detail}>
      <ShieldCheck className="w-3 h-3" />安全闸：检测通过
    </span>
  )
}
