import { useState } from 'react'
import { History, CheckCircle2, Gift, Zap, Wrench, ShieldCheck, Tag } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { CHANGELOG_HISTORY, CURRENT_VERSION } from '@/lib/changelog'

interface ChangelogModalProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  trigger?: React.ReactElement
}

export function ChangelogModal({ open, onOpenChange, trigger }: ChangelogModalProps) {
  const [selectedVersion, setSelectedVersion] = useState<string>(CURRENT_VERSION)
  const activeRelease = CHANGELOG_HISTORY.find((item) => item.version === selectedVersion) || CHANGELOG_HISTORY[0]

  const defaultTrigger = (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-violet-500/10 hover:bg-violet-500/20 text-violet-700 dark:text-violet-300 border border-violet-500/20 text-[11px] font-semibold transition-all cursor-pointer shadow-2xs hover:scale-105"
      title="点击查看版本更新日志"
    >
      <History className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400 stroke-[2]" />
      <span>{CURRENT_VERSION}</span>
    </button>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={trigger || defaultTrigger} />

      <DialogContent className="sm:max-w-3xl h-[560px] max-h-[85vh] bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 text-slate-900 dark:text-slate-100 rounded-3xl p-6 sm:p-7 shadow-2xl shadow-slate-950/15 flex flex-col overflow-hidden">
        <DialogHeader className="flex flex-row items-center gap-3.5 pb-4 border-b border-slate-100 dark:border-slate-800/80 shrink-0">
          <div className="w-11 h-11 rounded-2xl bg-violet-500/10 dark:bg-violet-500/15 flex items-center justify-center shrink-0 border border-violet-500/20">
            <History className="w-5 h-5 text-violet-600 dark:text-violet-400 stroke-[1.75]" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100">
                版本更新日志
              </DialogTitle>
              <Badge className="bg-violet-600 text-white text-[10px] font-mono px-2 py-0.5 rounded-md">
                当前 {CURRENT_VERSION}
              </Badge>
            </div>
            <DialogDescription className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              视译宝迭代演进记录与版本功能变更
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-12 gap-6 pt-4 overflow-hidden">
          {/* 左侧：版本列表 */}
          <div className="md:col-span-4 h-full flex flex-col border-r border-slate-100 dark:border-slate-800/60 pr-2 overflow-hidden">
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 px-2 mb-2 shrink-0">
              历史发布版本
            </p>
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {CHANGELOG_HISTORY.map((item) => {
                const isSelected = item.version === selectedVersion
                return (
                  <button
                    key={item.version}
                    onClick={() => setSelectedVersion(item.version)}
                    className={`w-full text-left p-3 rounded-2xl transition-all cursor-pointer flex flex-col gap-1 border ${
                      isSelected
                        ? 'bg-violet-500/10 dark:bg-violet-500/15 border-violet-500/30 text-violet-900 dark:text-violet-100 shadow-2xs ring-1 ring-violet-500/20'
                        : 'bg-slate-50/60 dark:bg-slate-800/40 border-slate-100 dark:border-slate-800/50 hover:bg-slate-100/80 dark:hover:bg-slate-800/80 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-xs flex items-center gap-1.5">
                        <Tag className="w-3 h-3 text-violet-500" />
                        {item.version}
                      </span>
                      {item.isLatest && (
                        <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-md border border-emerald-500/20">
                          最新版
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] font-medium text-slate-600 dark:text-slate-300 line-clamp-1">
                      {item.title}
                    </p>
                    <span className="text-[10px] text-slate-400 dark:text-slate-500">
                      {item.date}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 右侧：选中版本的详细更新 */}
          <div className="md:col-span-8 h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto space-y-4 pr-2">
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/60 pb-3">
                <div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    <span>{activeRelease.version}</span>
                    <span className="text-xs font-normal text-slate-500 dark:text-slate-400">({activeRelease.date})</span>
                  </h3>
                  <p className="text-xs font-medium text-violet-600 dark:text-violet-400 mt-0.5">
                    {activeRelease.title}
                  </p>
                </div>
              </div>

              {/* 核心亮点 */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                  <Gift className="w-3.5 h-3.5 text-violet-500" />
                  <span>版本核心亮点</span>
                </h4>
                <ul className="space-y-1.5">
                  {activeRelease.highlights.map((hl, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 p-2.5 rounded-xl border border-slate-100 dark:border-slate-800/40">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                      <span className="leading-relaxed">{hl}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* 详细更新列表 */}
              {activeRelease.details && (
                <div className="space-y-3 pt-2">
                  {activeRelease.details.features && activeRelease.details.features.length > 0 && (
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-md inline-flex items-center gap-1">
                        <Zap className="w-3 h-3" /> 新增功能
                      </span>
                      <ul className="list-disc list-inside text-xs text-slate-600 dark:text-slate-300 space-y-1 pl-1">
                        {activeRelease.details.features.map((item, i) => (
                          <li key={i}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {activeRelease.details.improvements && activeRelease.details.improvements.length > 0 && (
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-bold text-violet-600 dark:text-violet-400 bg-violet-500/10 px-2 py-0.5 rounded-md inline-flex items-center gap-1">
                        <Wrench className="w-3 h-3" /> 体验优化
                      </span>
                      <ul className="list-disc list-inside text-xs text-slate-600 dark:text-slate-300 space-y-1 pl-1">
                        {activeRelease.details.improvements.map((item, i) => (
                          <li key={i}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {activeRelease.details.fixes && activeRelease.details.fixes.length > 0 && (
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-md inline-flex items-center gap-1">
                        <ShieldCheck className="w-3 h-3" /> 问题修复
                      </span>
                      <ul className="list-disc list-inside text-xs text-slate-600 dark:text-slate-300 space-y-1 pl-1">
                        {activeRelease.details.fixes.map((item, i) => (
                          <li key={i}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default ChangelogModal
