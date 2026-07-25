import { useState, useEffect } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Cpu,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  Wrench,
  XCircle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { checkEnvironment, type EnvCheckResult, type EnvCheckItem } from '@/lib/api'

interface EnvironmentCheckModalProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  trigger?: React.ReactNode
  onOpenSettings?: () => void
}

export function EnvironmentCheckModal({
  open: controlledOpen,
  onOpenChange: setControlledOpen,
  trigger,
  onOpenSettings,
}: EnvironmentCheckModalProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const isOpen = isControlled ? controlledOpen : internalOpen

  const handleOpenChange = (newOpen: boolean) => {
    if (!isControlled) {
      setInternalOpen(newOpen)
    }
    setControlledOpen?.(newOpen)
  }

  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<EnvCheckResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const runCheck = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await checkEnvironment()
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法连接后端诊断服务')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen && !result && !loading) {
      runCheck()
    }
  }, [isOpen])

  const copyReport = () => {
    if (!result) return
    const passCount = result.checks.filter(c => c.status === 'pass').length
    const totalCount = result.checks.length
    const reportText = `[视译宝 环境诊断报告]
整体状态: ${result.overall_status.toUpperCase()} (${passCount}/${totalCount} 项通过)
系统环境: ${result.system_info.os} | Python ${result.system_info.python_version}

检测详情:
${result.checks
  .map(
    c =>
      `- [${c.status.toUpperCase()}] ${c.name}: ${c.detail}${
        c.recommendation ? ` (建议: ${c.recommendation})` : ''
      }`,
  )
  .join('\n')}`

    navigator.clipboard.writeText(reportText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const passCount = result?.checks.filter(c => c.status === 'pass').length || 0
  const totalCount = result?.checks.length || 0

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger render={trigger as React.ReactElement} />}

      <DialogContent className="sm:max-w-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-slate-900 dark:text-slate-100 rounded-3xl p-6 shadow-2xl relative max-h-[90vh] flex flex-col">
        <DialogHeader className="flex flex-row items-center gap-3 pb-3 border-b border-slate-100 dark:border-slate-800/60 shrink-0">
          <div className="w-10 h-10 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5 text-indigo-600 dark:text-indigo-400 stroke-[1.5]" />
          </div>
          <div>
            <DialogTitle className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <span>环境依赖健康诊断</span>
              {result && (
                <span
                  className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                    result.overall_status === 'ok'
                      ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                      : result.overall_status === 'warning'
                      ? 'bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border-amber-500/20'
                      : 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-rose-500/20'
                  }`}
                >
                  {result.overall_status === 'ok'
                    ? '完美就绪'
                    : result.overall_status === 'warning'
                    ? '基本就绪（建议优化）'
                    : '依赖受阻（需要修复）'}
                </span>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              自动检测编解码引擎、AI API 连接、识别库与磁盘写入权限
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-3 space-y-4 pr-1">
          {/* 总体得分统计 */}
          {result && (
            <div className="p-3.5 rounded-2xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800/60 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex flex-col">
                  <span className="text-[11px] text-slate-400 font-medium">健康度通过率</span>
                  <span className="text-xl font-bold font-mono text-slate-800 dark:text-slate-100">
                    {passCount} <span className="text-xs font-normal text-slate-400">/ {totalCount} 项</span>
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={runCheck}
                  disabled={loading}
                  className="h-8 text-xs gap-1.5 rounded-xl border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <RefreshCcw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                  <span>{loading ? '检测中...' : '重新检测'}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={copyReport}
                  className="h-8 text-xs gap-1.5 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{copied ? '已复制报告' : '复制报告'}</span>
                </Button>
              </div>
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 flex items-center gap-3">
              <XCircle className="w-5 h-5 text-rose-500 shrink-0" />
              <div className="text-xs text-rose-700 dark:text-rose-300 flex-1">{error}</div>
              <Button size="sm" variant="outline" onClick={runCheck} className="h-7 text-xs rounded-lg">
                重试
              </Button>
            </div>
          )}

          {/* 正在扫描框架 */}
          {loading && !result && (
            <div className="py-12 flex flex-col items-center justify-center gap-3 text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
              <span className="text-xs font-medium">正在全量扫描系统依赖与网络连通性...</span>
            </div>
          )}

          {/* 检测列表 */}
          {result && (
            <div className="space-y-2.5">
              {result.checks.map(item => (
                <CheckItemCard key={item.id} item={item} onOpenSettings={onOpenSettings} />
              ))}
            </div>
          )}

          {/* 系统环境基础信息 */}
          {result && (
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800/60 flex items-center justify-between text-[11px] text-slate-400 font-mono">
              <div className="flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-slate-400" />
                <span>{result.system_info.os}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-slate-400" />
                <span>Python {result.system_info.python_version}</span>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CheckItemCard({
  item,
  onOpenSettings,
}: {
  item: EnvCheckItem
  onOpenSettings?: () => void
}) {
  return (
    <div
      className={`p-3.5 rounded-2xl border transition-all flex items-start gap-3 ${
        item.status === 'pass'
          ? 'bg-slate-50/50 dark:bg-slate-800/20 border-slate-100 dark:border-slate-800/60'
          : item.status === 'warn'
          ? 'bg-amber-50/40 dark:bg-amber-950/20 border-amber-200/60 dark:border-amber-900/40'
          : 'bg-rose-50/40 dark:bg-rose-950/20 border-rose-200/60 dark:border-rose-900/40'
      }`}
    >
      <div className="mt-0.5 shrink-0">
        {item.status === 'pass' && <CheckCircle2 className="w-4 h-4 text-emerald-500 stroke-[2]" />}
        {item.status === 'warn' && <AlertTriangle className="w-4 h-4 text-amber-500 stroke-[2]" />}
        {item.status === 'fail' && <XCircle className="w-4 h-4 text-rose-500 stroke-[2]" />}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            {item.name}
          </span>
          <span
            className={`text-[10px] font-bold px-1.5 py-0.2 rounded-md ${
              item.status === 'pass'
                ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                : item.status === 'warn'
                ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10'
                : 'text-rose-600 dark:text-rose-400 bg-rose-500/10'
            }`}
          >
            {item.status === 'pass' ? '就绪' : item.status === 'warn' ? '建议优化' : '异常受阻'}
          </span>
        </div>

        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 font-mono leading-relaxed break-all">
          {item.detail}
        </p>

        {item.recommendation && (
          <div className="mt-2 p-2 rounded-xl bg-white/80 dark:bg-slate-900/80 border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
              <Wrench className="w-3 h-3 text-amber-500 shrink-0" />
              <span>{item.recommendation}</span>
            </span>
            {(item.id === 'gemini_api' || item.id === 'xiaomi_tts') && onOpenSettings && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenSettings}
                className="h-6 text-[10px] px-2 font-medium text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/50 rounded-lg shrink-0"
              >
                前往设置
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
