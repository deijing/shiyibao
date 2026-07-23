const ACTIVE_TASK_ID_KEY = 'shiyibao.activeTaskId'

export function loadActiveTaskId(): string | null {
  return window.localStorage.getItem(ACTIVE_TASK_ID_KEY)
}

export function saveActiveTaskId(taskId: string): void {
  window.localStorage.setItem(ACTIVE_TASK_ID_KEY, taskId)
}

export function clearActiveTaskId(): void {
  window.localStorage.removeItem(ACTIVE_TASK_ID_KEY)
}
