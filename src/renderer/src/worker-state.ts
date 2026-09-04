import type { ChatEvent, ChatMessage } from '../../shared/contracts'

export type ChatUiMessage = ChatMessage & { id: string; failed?: boolean }
export type ThreadRunState = Record<string, { requestId: string; status: 'queued' | 'running' }>

export function applyRunEvent(current: ThreadRunState, event: ChatEvent): ThreadRunState {
  if (event.type === 'status') {
    if (event.status === 'queued' && current[event.threadId]?.status === 'running') return current
    return { ...current, [event.threadId]: { requestId: event.requestId, status: event.status } }
  }
  if (event.type !== 'done' && event.type !== 'error') return current
  if (current[event.threadId]?.requestId !== event.requestId) return current
  const next = { ...current }
  delete next[event.threadId]
  return next
}

export function applyMessageEvent(
  current: Record<string, ChatUiMessage[]>,
  event: ChatEvent
): Record<string, ChatUiMessage[]> {
  const messages = current[event.threadId] ?? []
  if (event.type === 'status') {
    return current
  }
  if (event.type === 'started') {
    const withUserMessage = messages.some((message) => message.id === event.userMessageId)
      ? messages
      : [...messages, {
          id: event.userMessageId,
          role: 'user' as const,
          content: event.userContent,
          images: event.images
        }]
    return withUserMessage.some((message) => message.id === event.requestId)
      ? current
      : { ...current, [event.threadId]: [...withUserMessage, { id: event.requestId, role: 'assistant', content: '' }] }
  }
  if (event.type === 'content') {
    return { ...current, [event.threadId]: messages.map((message) => message.id === event.requestId
      ? { ...message, content: message.content + event.content }
      : message) }
  }
  if (event.type === 'error') {
    return { ...current, [event.threadId]: messages.map((message) => message.id === event.requestId
      ? { ...message, content: message.content || event.reason, failed: true }
      : message) }
  }
  return current
}
