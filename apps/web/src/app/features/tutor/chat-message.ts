import { ApiError, friendlyMessage } from '../../core/http/api-error';
import { Message, SendMessageRequest } from '../../core/models/api.models';

/** A message plus client-only state. */
export interface ChatMessage extends Message {
  localId: string;
  statusText: string | null;
  slow: boolean;
  error: ApiError | null;
  notice: string | null;
  /** What to send again for Retry / Ask again. */
  request: SendMessageRequest | null;
  /**
   * Loaded from history while the server still had it as `streaming` (still being written, or stuck).
   * Shown read-only with Refresh / Stop actions; it never locks the composer.
   */
  serverStreaming: boolean;
}

export const STOPPED_NOTICE = 'You stopped this answer.';
export const INTERRUPTED_MESSAGE = friendlyMessage('STREAM_INTERRUPTED');
export const SERVER_STREAMING_NOTICE = 'Sathi may still be writing this answer, or it got stuck. Refresh to check, or stop it.';

/** Rebuilds the request behind an assistant answer from the user message before it (not for Simpler/Harder). */
export function requestFor(list: Message[], index: number): SendMessageRequest | null {
  const asst = list[index];
  const user = list[index - 1];
  if (!asst || asst.role !== 'assistant' || !user || user.role !== 'user' || user.adjust || !user.content.trim()) return null;
  return { content: user.content, level: asst.level, mode: asst.mode, webSearch: asst.webSearch };
}

/** Maps a conversation loaded from the API to chat messages. Nothing loaded from history is ever `streaming` locally. */
export function fromHistory(list: Message[]): ChatMessage[] {
  return list.map((m, i) => {
    const base: ChatMessage = { ...m, localId: m.id, statusText: null, slow: false, error: null, notice: null, request: null, serverStreaming: false };
    if (m.role !== 'assistant') return base;
    switch (m.status) {
      case 'streaming':
        return { ...base, status: 'partial', serverStreaming: true, notice: SERVER_STREAMING_NOTICE };
      case 'cancelled':
        return { ...base, notice: STOPPED_NOTICE, request: requestFor(list, i) };
      case 'partial':
        return { ...base, notice: 'This answer was cut short.', request: requestFor(list, i) };
      case 'failed': {
        const interrupted = m.errorCode === 'STREAM_INTERRUPTED';
        const error = new ApiError({
          status: 503,
          code: m.errorCode ?? 'INTERNAL_ERROR',
          detail: interrupted ? INTERRUPTED_MESSAGE : undefined,
          referenceId: m.referenceId,
        });
        return { ...base, error, request: requestFor(list, i) };
      }
      default:
        return base;
    }
  });
}

/** The local state of an answer the student stopped: never an error, keeps any text so far. */
export function stoppedPatch(): Partial<ChatMessage> {
  return { status: 'cancelled', statusText: null, slow: false, error: null, notice: STOPPED_NOTICE, serverStreaming: false };
}

/** True while an answer is actively streaming in this tab (locks the composer and shows Stop). */
export function isStreaming(list: ChatMessage[]): boolean {
  return list.some((m) => m.status === 'streaming' && !m.serverStreaming);
}
