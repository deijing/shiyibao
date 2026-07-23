import { Bell, CheckCircle2, Clock3, Sun, Moon } from 'lucide-react'
import SettingsPanel from './SettingsPanel'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTaskNotifications } from '@/hooks/useTaskNotifications'

export type Page = 'home' | 'history' | 'voices' | 'performance'

interface NavbarProps {
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  activePage: Page
  onNavigate: (page: Page) => void
  onOpenCompletedTask: (taskId: string) => void
}

const NAV_ITEMS: { page: Page; label: string }[] = [
  { page: 'home', label: '首页' },
  { page: 'history', label: '历史项目' },
  { page: 'voices', label: '音色库' },
  { page: 'performance', label: '性能调度' },
]

function notificationTime(dateStr: string): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000))
  if (elapsedSeconds < 60) return '刚刚'
  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  return new Date(dateStr).toLocaleString('zh-CN', { hour12: false })
}

export default function Navbar({
  theme,
  onToggleTheme,
  activePage,
  onNavigate,
  onOpenCompletedTask,
}: NavbarProps) {
  const { notifications, unreadCount, markAllRead, markRead } = useTaskNotifications()

  return (
    <nav className="w-full border-b border-border glass-panel sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3.5 cursor-pointer group" onClick={() => onNavigate('home')}>
          <img
            src="/logo.png"
            alt="视译宝 Logo"
            className="h-6 sm:h-7 md:h-8 w-auto object-contain shrink-0 transition-transform group-hover:scale-105"
          />
          <span className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">
            视译宝
          </span>
        </div>

        <div className="hidden md:flex items-center gap-8 text-sm font-medium text-muted-foreground">
          {NAV_ITEMS.map(({ page, label }) => (
            <button
              key={page}
              onClick={() => onNavigate(page)}
              className={`relative cursor-pointer transition-colors ${
                activePage === page
                  ? 'text-foreground after:content-[""] after:absolute after:bottom-[-22px] after:left-0 after:w-full after:h-0.5 after:bg-violet-600 dark:after:bg-violet-400 font-semibold'
                  : 'hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleTheme}
            className="rounded-full bg-surface2 hover:bg-accent transition"
          >
            {theme === 'dark' ? (
              <Sun className="w-4 h-4 text-muted-foreground" />
            ) : (
              <Moon className="w-4 h-4 text-muted-foreground" />
            )}
          </Button>
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
              className="w-80 rounded-2xl border border-border bg-popover p-0 shadow-xl overflow-hidden"
            >
              <div className="flex items-center justify-between px-4 py-3 text-sm font-semibold text-foreground">
                <span>任务通知</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {unreadCount > 0 ? `${unreadCount} 条未读` : '全部已读'}
                </span>
              </div>
              <DropdownMenuSeparator className="m-0" />

              {notifications.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-5 py-8 text-center text-muted-foreground">
                  <Bell className="w-7 h-7 opacity-40" />
                  <p className="text-sm">暂无任务通知</p>
                  <p className="text-xs">转译完成后会在这里提醒你</p>
                </div>
              ) : (
                notifications.slice(0, 8).map((notification) => (
                  <DropdownMenuItem
                    key={notification.id}
                    onClick={() => {
                      markRead(notification.id)
                      onOpenCompletedTask(notification.taskId)
                    }}
                    className="items-start gap-3 rounded-none border-b border-border/60 px-4 py-3 cursor-pointer focus:bg-accent"
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500">
                      <CheckCircle2 className="w-4 h-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">视频转译已完成</span>
                      <span className="block truncate text-xs text-muted-foreground mt-0.5">{notification.filename}</span>
                      <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground/80">
                        <Clock3 className="w-3 h-3" />
                        {notificationTime(notification.completedAt)}
                      </span>
                    </span>
                    {!notification.read && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-violet-600" />}
                  </DropdownMenuItem>
                ))
              )}

              <button
                type="button"
                onClick={() => onNavigate('history')}
                className="w-full px-4 py-3 text-center text-xs font-medium text-violet-600 dark:text-violet-400 hover:bg-accent transition cursor-pointer"
              >
                查看全部历史任务
              </button>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </nav>
  )
}
