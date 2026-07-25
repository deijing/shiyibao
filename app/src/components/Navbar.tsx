import { Bell, CheckCircle2, Clock3, Sun, Moon, Loader2, ChevronRight, ShieldCheck, Menu } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { GithubIcon } from './GithubIcon'
import { ChangelogModal } from './ChangelogModal'
import SettingsPanel from './SettingsPanel'
import { EnvironmentCheckModal } from './EnvironmentCheckModal'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTaskNotifications } from '@/hooks/useTaskNotifications'

export type Page = 'home' | 'batch' | 'history' | 'voices' | 'performance'

interface NavbarProps {
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  activePage?: Page
  onNavigate?: (page: Page) => void
  onOpenCompletedTask: (taskId: string) => void
  activeProcessingTaskId?: string | null
  onOpenProcessingTask?: () => void
}

const NAV_ITEMS: { page: Page; path: string; label: string }[] = [
  { page: 'home', path: '/', label: '首页' },
  { page: 'batch', path: '/batch', label: '批量模式' },
  { page: 'history', path: '/history', label: '历史项目' },
  { page: 'voices', path: '/voices', label: '音色库' },
  { page: 'performance', path: '/performance', label: '性能调度' },
]

function notificationTime(dateStr: string): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000))
  if (elapsedSeconds < 60) return '刚刚'
  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  return new Date(dateStr).toLocaleString('zh-CN', { hour12: false })
}

function formatFilename(filename: string, maxLength: number = 24): string {
  if (!filename || filename.length <= maxLength) return filename
  const lastDotIndex = filename.lastIndexOf('.')
  if (lastDotIndex > 0 && filename.length - lastDotIndex <= 8) {
    const ext = filename.slice(lastDotIndex)
    const baseName = filename.slice(0, lastDotIndex)
    const frontLen = 12
    const backLen = 5
    if (baseName.length > frontLen + backLen + 3) {
      return `${baseName.slice(0, frontLen)}...${baseName.slice(-backLen)}${ext}`
    }
  }
  return `${filename.slice(0, 12)}...${filename.slice(-8)}`
}

export default function Navbar({
  theme,
  onToggleTheme,
  activePage: propActivePage,
  onNavigate: propOnNavigate,
  onOpenCompletedTask,
  activeProcessingTaskId,
  onOpenProcessingTask,
}: NavbarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { notifications, unreadCount, markAllRead, markRead } = useTaskNotifications()

  // 根据路径确定当前页面；非顶层导航路由（如 /task/:id）不高亮任何标签。
  let currentActivePage: Page | null
  if (location.pathname === '/batch') currentActivePage = 'batch'
  else if (location.pathname === '/history') currentActivePage = 'history'
  else if (location.pathname === '/voices') currentActivePage = 'voices'
  else if (location.pathname === '/performance') currentActivePage = 'performance'
  else if (location.pathname === '/') currentActivePage = 'home'
  else currentActivePage = propActivePage ?? null


  const handleNav = (targetPage: Page, path: string) => {
    if (propOnNavigate) propOnNavigate(targetPage)
    navigate(path)
  }

  return (
    <nav className="w-full border-b border-border glass-panel sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-3.5 cursor-pointer group" onClick={() => handleNav('home', '/')}>
            <img
              src="/logo.png"
              alt="视译宝 Logo"
              className="h-6 sm:h-7 md:h-8 w-auto object-contain shrink-0 transition-transform group-hover:scale-105"
            />
            <span className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">
              视译宝
            </span>
          </div>
          <ChangelogModal />
        </div>

        {/* 桌面端标准导航 */}
        <div className="hidden md:flex items-center gap-6 lg:gap-8 text-sm font-medium text-muted-foreground">
          {NAV_ITEMS.map(({ page, path, label }) => (
            <button
              key={page}
              onClick={() => handleNav(page, path)}
              className={`relative cursor-pointer transition-colors ${currentActivePage === page
                  ? 'text-foreground after:content-[""] after:absolute after:bottom-[-22px] after:left-0 after:w-full after:h-0.5 after:bg-violet-600 dark:after:bg-violet-400 font-semibold'
                  : 'hover:text-foreground'
                }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 移动端 / 小屏悬浮导航下拉菜单 */}
        <div className="flex md:hidden items-center">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="切换功能页面"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-surface2 hover:bg-accent border border-slate-200/80 dark:border-slate-800 transition cursor-pointer text-slate-700 dark:text-slate-200"
            >
              <Menu className="w-4 h-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44 rounded-2xl bg-popover p-1.5 shadow-lg border border-slate-200 dark:border-slate-800">
              {NAV_ITEMS.map(({ page, path, label }) => (
                <DropdownMenuItem
                  key={page}
                  onClick={() => handleNav(page, path)}
                  className={`px-3 py-2 text-xs font-semibold rounded-xl cursor-pointer ${
                    currentActivePage === page
                      ? 'bg-violet-50 dark:bg-violet-950/60 text-violet-600 dark:text-violet-400'
                      : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-3.5">
          {activeProcessingTaskId && onOpenProcessingTask && (
            <button
              onClick={onOpenProcessingTask}
              className="hidden sm:flex items-center gap-2 px-3 py-1 rounded-full bg-purple-50 dark:bg-purple-950/60 border border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-300 text-xs font-semibold hover:bg-purple-100 dark:hover:bg-purple-900/60 transition-all cursor-pointer shadow-2xs animate-pulse"
              title="有任务正在后台转译中，点击可返回控制台"
            >
              <span className="w-2 h-2 rounded-full bg-purple-600 dark:bg-purple-400" />
              <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-600 dark:text-purple-400" />
              <span>任务后台处理中</span>
            </button>
          )}

          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleTheme}
            className="rounded-full bg-surface2 hover:bg-accent transition cursor-pointer"
            title={theme === 'dark' ? '切换为浅色模式' : '切换为深色模式'}
          >
            {theme === 'dark' ? (
              <Sun className="w-4 h-4 text-muted-foreground" />
            ) : (
              <Moon className="w-4 h-4 text-muted-foreground" />
            )}
          </Button>
          <a
            href="https://github.com/deijing/shiyibao"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center gap-1.5 px-3 rounded-full bg-surface2 hover:bg-accent border border-slate-200/60 dark:border-slate-800/80 text-xs font-medium text-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white transition-all cursor-pointer shadow-2xs"
            title="GitHub 开源仓库 (deijing/shiyibao)"
          >
            <GithubIcon className="w-4 h-4 text-slate-800 dark:text-slate-100" />
            <span className="hidden sm:inline font-semibold">GitHub</span>
          </a>
          <EnvironmentCheckModal
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className="rounded-xl border-0 bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-200/80 dark:hover:bg-slate-700/80 transition-all duration-200"
                title="环境健康度与依赖检测"
              >
                <ShieldCheck className="w-4 h-4 text-indigo-600 dark:text-indigo-400 stroke-[1.5]" />
              </Button>
            }
          />
          <SettingsPanel />
          <DropdownMenu onOpenChange={(open) => open && markAllRead()}>
            <DropdownMenuTrigger
              aria-label={unreadCount > 0 ? `任务通知，${unreadCount} 条未读` : '任务通知'}
              className="relative inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface2 hover:bg-accent transition outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 cursor-pointer"
            >
              <Bell className={`w-4 h-4 ${unreadCount > 0 ? 'text-violet-600 dark:text-violet-400' : 'text-muted-foreground'}`} />
              {unreadCount > 0 && (
                <span className="absolute -right-1 -top-1 min-w-4 h-4 px-1 rounded-full bg-rose-500 text-[10px] leading-4 font-bold text-white text-center shadow-sm ring-2 ring-background">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </DropdownMenuTrigger>

            <DropdownMenuContent
              align="end"
              sideOffset={10}
              className="w-84 sm:w-88 rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-popover p-0 shadow-[0_10px_30px_rgba(0,0,0,0.08)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.4)] overflow-hidden"
            >
              <div className="flex items-center justify-between px-4.5 py-3.5 border-b border-slate-100 dark:border-slate-800/80 text-foreground">
                <span className="text-sm font-bold tracking-tight text-slate-900 dark:text-slate-100">任务通知</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    markAllRead()
                  }}
                  className="text-xs font-medium text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 hover:underline transition cursor-pointer"
                >
                  全部已读
                </button>
              </div>

              {notifications.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-5 py-8 text-center text-muted-foreground">
                  <Bell className="w-7 h-7 opacity-40" />
                  <p className="text-sm">暂无任务通知</p>
                  <p className="text-xs">转译完成后会在这里提醒你</p>
                </div>
              ) : (
                <div className="max-h-[380px] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/50">
                  {notifications.slice(0, 8).map((notification) => (
                    <DropdownMenuItem
                      key={notification.id}
                      onClick={() => {
                        markRead(notification.id)
                        onOpenCompletedTask(notification.taskId)
                      }}
                      className="flex items-center gap-3.5 px-4.5 py-3.5 cursor-pointer rounded-none hover:bg-slate-50 dark:hover:bg-slate-800/50 focus:bg-slate-50 dark:focus:bg-slate-800/50 transition-colors"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500">
                        <CheckCircle2 className="w-4.5 h-4.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className="block text-sm font-medium text-slate-800 dark:text-slate-100 leading-snug"
                          title={notification.filename}
                        >
                          {formatFilename(notification.filename)}
                        </span>
                        <span className="mt-1 flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-400">
                          <span>转译成功</span>
                          <span>·</span>
                          <span className="flex items-center gap-1">
                            <Clock3 className="w-3 h-3 text-slate-400/80" />
                            {notificationTime(notification.completedAt)}
                          </span>
                        </span>
                      </span>
                      {!notification.read && (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-violet-600 dark:bg-violet-400" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </div>
              )}

              <div className="border-t border-slate-100 dark:border-slate-800/80 bg-slate-50/70 dark:bg-slate-900/50">
                <button
                  type="button"
                  onClick={() => handleNav('history', '/history')}
                  className="group w-full px-4 py-3 text-center text-xs font-semibold text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 hover:bg-slate-100/60 dark:hover:bg-slate-800/60 transition-all cursor-pointer flex items-center justify-center gap-1"
                >
                  <span>查看全部历史任务</span>
                  <ChevronRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                </button>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </nav>
  )
}
