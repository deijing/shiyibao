import { useCallback, useEffect, useState } from 'react'
import { getTaskList, type TaskListItem } from '@/lib/api'

const NOTIFICATIONS_KEY = 'shiyibao.taskNotifications'
const TASK_STAGES_KEY = 'shiyibao.taskStages'
const POLL_INTERVAL_MS = 3000
const MAX_NOTIFICATIONS = 20

export interface TaskNotification {
  id: string
  taskId: string
  filename: string
  completedAt: string
  read: boolean
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function loadNotifications(): TaskNotification[] {
  const value = loadJson<unknown>(NOTIFICATIONS_KEY, [])
  return Array.isArray(value) ? value as TaskNotification[] : []
}

function loadTaskStages(): Record<string, string> {
  const value = loadJson<unknown>(TASK_STAGES_KEY, {})
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, string>
    : {}
}

function completedNotification(task: TaskListItem): TaskNotification {
  return {
    id: `${task.task_id}:complete`,
    taskId: task.task_id,
    filename: task.filename,
    completedAt: new Date().toISOString(),
    read: false,
  }
}

export function useTaskNotifications() {
  const [notifications, setNotifications] = useState<TaskNotification[]>(loadNotifications)

  useEffect(() => {
    window.localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifications))
  }, [notifications])

  useEffect(() => {
    let stopped = false

    const pollTasks = async () => {
      try {
        const tasks = await getTaskList()
        if (stopped) return

        const previousStages = loadTaskStages()
        const nextStages = Object.fromEntries(tasks.map((task) => [task.task_id, task.stage]))
        const newCompletions = tasks.filter((task) => (
          task.stage === 'complete' &&
          previousStages[task.task_id] !== undefined &&
          previousStages[task.task_id] !== 'complete'
        ))
        const currentTaskIds = new Set(tasks.map((task) => task.task_id))

        setNotifications((current) => {
          const retained = current.filter((item) => currentTaskIds.has(item.taskId))
          const existingIds = new Set(retained.map((item) => item.id))
          const additions = newCompletions
            .map(completedNotification)
            .filter((item) => !existingIds.has(item.id))
          if (additions.length === 0 && retained.length === current.length) {
            return current
          }
          return [...additions, ...retained].slice(0, MAX_NOTIFICATIONS)
        })
        window.localStorage.setItem(TASK_STAGES_KEY, JSON.stringify(nextStages))
      } catch {
        // 临时 API 故障不应清除已有通知。
      }
    }

    void pollTasks()
    const timer = window.setInterval(pollTasks, POLL_INTERVAL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [])

  const markAllRead = useCallback(() => {
    setNotifications((current) => current.map((item) => (
      item.read ? item : { ...item, read: true }
    )))
  }, [])

  const markRead = useCallback((id: string) => {
    setNotifications((current) => current.map((item) => (
      item.id === id ? { ...item, read: true } : item
    )))
  }, [])

  return {
    notifications,
    unreadCount: notifications.filter((item) => !item.read).length,
    markAllRead,
    markRead,
  }
}
