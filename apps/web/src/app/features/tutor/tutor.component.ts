import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { firstValueFrom, Subscription } from 'rxjs';
import { LearningApi } from '../../core/api/learning.api';
import { TutorApi } from '../../core/api/tutor.api';
import { AuthStore } from '../../core/auth/auth.store';
import { ApiError, friendlyMessage, toApiError } from '../../core/http/api-error';
import { newIdempotencyKey } from '../../core/http/trace';
import { Adjust, Level, SendMessageRequest, TutorEvent, TutorMode } from '../../core/models/api.models';
import { OnlineService } from '../../core/platform/online.service';
import { AutosizeDirective } from '../../shared/ui/autosize/autosize.directive';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MarkdownViewComponent } from '../../shared/ui/markdown/markdown-view.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { ReferenceIdComponent } from '../../shared/ui/reference-id/reference-id.component';
import { ChatMessage, fromHistory, isStreaming, stoppedPatch } from './chat-message';
import { HistoryDrawerComponent } from './history-drawer.component';
import { basisSentence, SourceListComponent } from './source-list.component';

export type { ChatMessage } from './chat-message';

const LEVELS: { id: Level; label: string }[] = [
  { id: 'beginner', label: 'Beginner' },
  { id: 'intermediate', label: 'Intermediate' },
  { id: 'advanced', label: 'Advanced' },
];
const MODES: { id: TutorMode; label: string }[] = [
  { id: 'explain', label: 'Explain' },
  { id: 'hint', label: 'Give a hint' },
  { id: 'quiz_me', label: 'Quiz me' },
];
const SLOW_MS = 6000;
const MAX_LEN = 2000;
/** After Stop, how long we keep reading only to learn the message id (the `start` event) so we can cancel it. */
export const STOP_DRAIN_MS = 10_000;

/**
 * One answer being produced. Stop works in every phase:
 * - creating the conversation → the stream is never opened;
 * - stream open, `start` not yet received → keep reading only until `start`, then cancel + abort;
 * - `start` received → cancel + abort immediately.
 */
interface Run {
  localId: string;
  userLocalId: string;
  convId: string | null;
  messageId: string | null;
  sub: Subscription | null;
  stopped: boolean;
  drainTimer: ReturnType<typeof setTimeout> | null;
}

@Component({
  selector: 'app-tutor',
  imports: [
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatTooltipModule,
    AutosizeDirective,
    IconComponent,
    MarkdownViewComponent,
    SourceListComponent,
    HistoryDrawerComponent,
    ErrorStateComponent,
    SkeletonComponent,
    ReferenceIdComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tutor.component.html',
  styleUrl: './tutor.component.scss',
})
export default class TutorComponent implements OnInit {
  private readonly api = inject(TutorApi);
  private readonly learning = inject(LearningApi);
  private readonly auth = inject(AuthStore);
  private readonly location = inject(Location);
  readonly online = inject(OnlineService).online;

  /** Query params: ?conversation=…&lessonId=…&q=… */
  readonly conversation = input<string>('');
  readonly lessonIdParam = input<string>('', { alias: 'lessonId' });
  readonly q = input<string>('');

  readonly levels = LEVELS;
  readonly modes = MODES;
  readonly maxLen = MAX_LEN;

  readonly conversationId = signal<string | null>(null);
  readonly lessonId = signal<string | null>(null);
  readonly lessonTitle = signal<string | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly loadingConversation = signal(false);
  readonly loadError = signal<ApiError | null>(null);

  readonly level = signal<Level>(this.auth.me()?.preferences.level ?? 'intermediate');
  readonly mode = signal<TutorMode>('explain');
  readonly webSearch = signal(false);
  readonly draft = signal('');
  readonly historyOpen = signal(false);
  readonly announce = signal('');

  readonly selectedSourcesId = signal<string | null>(null);
  readonly highlight = signal<{ localId: string; index: number } | null>(null);
  readonly inlineOpen = signal<Set<string>>(new Set());

  readonly streaming = computed(() => isStreaming(this.messages()));
  readonly canSend = computed(() => this.draft().trim().length > 0 && !this.streaming() && this.online() && this.draft().length <= MAX_LEN);
  readonly canStartNew = computed(() => this.messages().length > 0 || !!this.conversationId() || !!this.loadError());
  readonly sourcesMessage = computed(() => {
    const msgs = this.messages();
    const chosen = msgs.find((m) => m.localId === this.selectedSourcesId());
    return chosen ?? [...msgs].reverse().find((m) => m.role === 'assistant' && m.citations.length > 0) ?? null;
  });
  readonly title = computed(() => this.lessonTitle() ?? 'Ask anything');
  readonly suggestions = computed(() =>
    this.lessonTitle()
      ? [`Summarise “${this.lessonTitle()}” in three sentences`, 'Why do we divide by √d in attention?', 'Quiz me on this lesson']
      : ['Why do we divide by √d in attention?', 'Explain backpropagation with an analogy', 'What is reciprocal rank fusion?'],
  );

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly input = viewChild<ElementRef<HTMLTextAreaElement>>('composer');
  /** The answer currently streaming into the UI. */
  private active: Run | null = null;
  /** Stopped runs still waiting for `start` so the server can be told to cancel. */
  private readonly draining = new Set<Run>();
  private slowTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.detach();
      for (const run of [...this.draining]) this.endRun(run);
      this.clearSlow();
    });
  }

  ngOnInit(): void {
    if (this.q()) this.draft.set(this.q().slice(0, MAX_LEN));
    if (this.conversation()) void this.open(this.conversation());
    else if (this.lessonIdParam()) this.setLesson(this.lessonIdParam());
  }

  // ------------------------------------------------------------- conversations
  async open(id: string): Promise<void> {
    this.detach();
    this.historyOpen.set(false);
    this.loadingConversation.set(true);
    this.loadError.set(null);
    try {
      const c = await firstValueFrom(this.api.conversation(id));
      this.conversationId.set(c.id);
      this.lessonId.set(c.lessonId);
      this.lessonTitle.set(c.lessonTitle);
      this.messages.set(fromHistory(c.messages));
      this.selectedSourcesId.set(null);
      this.location.replaceState('/tutor', `conversation=${c.id}`);
      this.scrollToBottom(true);
    } catch (e) {
      this.loadError.set(toApiError(e));
    } finally {
      this.loadingConversation.set(false);
    }
  }

  /** Starts over: keeps level, mode, web search and lesson; clears the conversation. */
  newConversation(): void {
    this.detach();
    this.historyOpen.set(false);
    this.conversationId.set(null);
    this.messages.set([]);
    this.loadError.set(null);
    this.selectedSourcesId.set(null);
    this.inlineOpen.set(new Set());
    this.location.replaceState('/tutor', this.lessonId() ? `lessonId=${this.lessonId()}` : '');
    this.announce.set('New conversation started.');
    setTimeout(() => this.input()?.nativeElement.focus());
  }

  onDeleted(id: string): void {
    if (id === this.conversationId()) this.newConversation();
  }

  private setLesson(lessonId: string): void {
    this.lessonId.set(lessonId);
    this.learning.lesson(lessonId).subscribe({ next: (l) => this.lessonTitle.set(l.title), error: () => undefined });
  }

  // ------------------------------------------------------------- sending
  onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void this.submit();
    }
  }

  async submit(text = this.draft()): Promise<void> {
    const content = text.trim();
    if (!content || this.streaming()) return;
    this.draft.set('');
    await this.send({ content, level: this.level(), mode: this.mode(), webSearch: this.webSearch() });
  }

  adjust(m: ChatMessage, adjust: Adjust): void {
    if (this.streaming()) return;
    void this.send({ content: '', level: this.level(), mode: 'explain', adjust, webSearch: this.webSearch(), replyToMessageId: m.id });
  }

  retry(m: ChatMessage): void {
    if (!m.request || this.streaming()) return;
    const req = m.request;
    // Drop the failed/stopped pair; the retry creates a fresh one (new idempotency key).
    this.messages.update((list) => {
      const i = list.findIndex((x) => x.localId === m.localId);
      return list.filter((_, idx) => idx !== i && !(idx === i - 1 && list[idx].role === 'user'));
    });
    void this.send(req);
  }

  private async send(req: SendMessageRequest): Promise<void> {
    const courseId = this.auth.activeCourseId();
    const now = new Date().toISOString();
    const userText = req.adjust ? (req.adjust === 'simpler' ? 'Explain that more simply' : 'Go deeper') : req.content;
    const base: Omit<ChatMessage, 'id' | 'localId' | 'role' | 'content' | 'status'> = { level: req.level, mode: req.mode, adjust: req.adjust ?? null, webSearch: req.webSearch, citations: [], answerBasis: [], errorCode: null, referenceId: null, feedback: null, createdAt: now, statusText: null, slow: false, error: null, notice: null, request: null, serverStreaming: false };
    const userMsg: ChatMessage = { ...base, id: '', localId: `u-${newIdempotencyKey()}`, role: 'user', content: userText, status: 'complete' };
    const asst: ChatMessage = { ...base, id: '', localId: `a-${newIdempotencyKey()}`, role: 'assistant', content: '', status: 'streaming', statusText: 'Connecting…', request: req };
    const run: Run = { localId: asst.localId, userLocalId: userMsg.localId, convId: this.conversationId(), messageId: null, sub: null, stopped: false, drainTimer: null };
    this.detach();
    this.active = run;
    this.messages.update((l) => [...l, userMsg, asst]);
    this.announce.set('Sathi is working on your answer.');
    this.scrollToBottom(true);
    this.armSlow(asst.localId);

    if (!run.convId) {
      if (!courseId) {
        this.finishRun(run);
        this.patch(asst.localId, { status: 'failed', statusText: null, error: new ApiError({ status: 404, code: 'NOT_FOUND', detail: 'Choose a course first so the tutor knows what to draw on.' }) });
        return;
      }
      try {
        const created = await firstValueFrom(this.api.create(courseId, this.lessonId()));
        run.convId = created.id;
        // Keep the conversation even if Stop was pressed meanwhile: the next question goes into it.
        if (!this.conversationId()) {
          this.conversationId.set(created.id);
          this.location.replaceState('/tutor', `conversation=${created.id}`);
        }
      } catch (e) {
        if (run.stopped) return;
        this.finishRun(run);
        this.patch(asst.localId, { status: 'failed', statusText: null, error: toApiError(e) });
        return;
      }
      if (run.stopped || this.active !== run) return; // Stop pressed while "Connecting…": never open the stream.
    }

    run.sub = this.api.stream(run.convId!, req).subscribe({
      next: (ev) => this.onEvent(run, ev),
      error: (e: unknown) => this.onStreamError(run, e),
      complete: () => this.onStreamComplete(run),
    });
  }

  private onEvent(run: Run, ev: TutorEvent): void {
    if (run.stopped) {
      // Stopped before the server told us the message id: now we know it, cancel and abort.
      if (ev.event === 'start') {
        run.messageId = ev.data.assistantMessageId;
        run.convId = ev.data.conversationId || run.convId;
        this.patch(run.localId, { id: ev.data.assistantMessageId, referenceId: ev.data.referenceId });
        this.patch(run.userLocalId, { id: ev.data.userMessageId });
        this.requestCancel(run);
        this.endRun(run);
      }
      return;
    }
    const localId = run.localId;
    switch (ev.event) {
      case 'start':
        run.messageId = ev.data.assistantMessageId;
        run.convId = ev.data.conversationId || run.convId;
        this.patch(localId, { id: ev.data.assistantMessageId, referenceId: ev.data.referenceId });
        this.patch(run.userLocalId, { id: ev.data.userMessageId });
        break;
      case 'status':
        this.patch(localId, { statusText: ev.data.message });
        break;
      case 'token': {
        const m = this.find(localId);
        if (!m) return;
        if (!m.content) this.clearSlow();
        this.patch(localId, { content: m.content + ev.data.text, statusText: null, slow: false });
        this.scrollToBottom();
        break;
      }
      case 'citation': {
        const m = this.find(localId);
        if (!m) return;
        const { requestId: _r, ...citation } = ev.data;
        this.patch(localId, { citations: [...m.citations.filter((c) => c.index !== citation.index), citation] });
        break;
      }
      case 'usage':
        break;
      case 'error': {
        this.clearSlow();
        const err = new ApiError({ status: 503, code: ev.data.code, detail: ev.data.message || friendlyMessage(ev.data.code), referenceId: ev.data.referenceId });
        const m = this.find(localId);
        this.patch(localId, { status: m?.content ? 'partial' : 'failed', statusText: null, errorCode: ev.data.code, referenceId: ev.data.referenceId, error: err });
        this.announce.set(`The tutor couldn’t answer. ${err.userMessage} Reference ${ev.data.referenceId}.`);
        break;
      }
      case 'done': {
        this.clearSlow();
        if (ev.data.status === 'cancelled' || ev.data.warnings.includes('CANCELLED')) {
          // Cancelled elsewhere (another tab, or the server): show it as stopped, never as a finished answer.
          const m = this.find(localId);
          this.patch(localId, { ...stoppedPatch(), id: ev.data.messageId || m?.id || '', content: ev.data.content || m?.content || '' });
          this.announce.set('Stopped.');
          break;
        }
        const notices: string[] = [];
        if (ev.data.warnings.includes('WEB_SEARCH_FAILED')) notices.push('Web search didn’t work this time, so this answer uses your course and notes only.');
        if (ev.data.warnings.includes('RAG_NO_RESULTS')) notices.push('Nothing in your course or notes matched, so this is a general explanation.');
        this.patch(localId, { id: ev.data.messageId, content: ev.data.content, answerBasis: ev.data.answerBasis, status: 'complete', statusText: null, notice: notices.join(' ') || null });
        const m = this.find(localId);
        this.announce.set(`Answer ready${m?.citations.length ? ` with ${m.citations.length} source${m.citations.length === 1 ? '' : 's'}` : ''}. ${basisSentence(ev.data.answerBasis)}.`);
        this.selectedSourcesId.set(null);
        break;
      }
    }
  }

  private onStreamError(run: Run, e: unknown): void {
    if (run.stopped) {
      this.endRun(run);
      return;
    }
    this.finishRun(run);
    const err = toApiError(e);
    const m = this.find(run.localId);
    if (m?.status !== 'streaming') return;
    this.patch(run.localId, { status: m.content ? 'partial' : 'failed', statusText: null, error: err });
    this.announce.set(`The answer didn’t finish. ${err.userMessage}`);
  }

  private onStreamComplete(run: Run): void {
    if (run.stopped) {
      this.endRun(run);
      return;
    }
    this.finishRun(run);
    const m = this.find(run.localId);
    if (m?.status === 'streaming') this.patch(run.localId, { status: 'complete', statusText: null });
  }

  /**
   * Stop: always ends the local streaming state at once (the composer unlocks), aborts the fetch and
   * asks the server to cancel — now if the message id is known, otherwise as soon as `start` delivers it.
   */
  stop(): void {
    this.clearSlow();
    const run = this.active;
    this.active = null;
    // Unlock anything still marked as streaming locally, whatever state we are in.
    this.messages.update((l) => l.map((m) => (m.status === 'streaming' ? { ...m, ...stoppedPatch() } : m)));
    this.announce.set('Stopped.');
    if (!run) return;
    run.stopped = true;
    if (run.messageId && run.convId) {
      this.requestCancel(run);
      this.endRun(run);
    } else if (run.sub) {
      this.draining.add(run);
      run.drainTimer = setTimeout(() => this.endRun(run), STOP_DRAIN_MS);
    }
    // No stream yet (still creating the conversation): send() sees `stopped` and never opens it.
  }

  /** Stops an answer that was loaded from history while the server still had it as `streaming`. */
  stopServerAnswer(m: ChatMessage): void {
    const convId = this.conversationId();
    this.patch(m.localId, stoppedPatch());
    this.announce.set('Stopped.');
    if (convId && m.id) this.api.cancel(convId, m.id).subscribe({ error: () => undefined });
  }

  refresh(): void {
    const id = this.conversationId();
    if (id) void this.open(id);
  }

  /** Leaves the current answer running on the server (it is saved there) but stops listening — used when switching away. */
  private detach(): void {
    const run = this.active;
    if (!run) return;
    this.active = null;
    run.sub?.unsubscribe();
    run.sub = null;
    run.stopped = true;
    this.clearSlow();
  }

  private requestCancel(run: Run): void {
    if (run.convId && run.messageId) this.api.cancel(run.convId, run.messageId).subscribe({ error: () => undefined });
  }

  private endRun(run: Run): void {
    if (run.drainTimer) clearTimeout(run.drainTimer);
    run.drainTimer = null;
    run.sub?.unsubscribe();
    run.sub = null;
    this.draining.delete(run);
  }

  private finishRun(run: Run): void {
    this.clearSlow();
    if (this.active === run) this.active = null;
  }

  // ------------------------------------------------------------- feedback & sources
  feedback(m: ChatMessage, rating: 1 | -1): void {
    if (!m.id) return;
    const previous = m.feedback;
    this.patch(m.localId, { feedback: rating });
    this.api.feedback(m.id, rating).subscribe({ error: () => this.patch(m.localId, { feedback: previous }) });
    this.announce.set(rating === 1 ? 'Thanks — marked as helpful.' : 'Thanks — marked as not helpful.');
  }

  onCite(m: ChatMessage, index: number): void {
    this.highlight.set({ localId: m.localId, index });
    const wide = window.matchMedia('(min-width: 1100px)').matches;
    let id: string;
    if (wide) {
      this.selectedSourcesId.set(m.localId);
      id = `side-src-${index}`;
    } else {
      this.inlineOpen.update((s) => new Set(s).add(m.localId));
      id = `msg-${m.localId}-src-${index}`;
    }
    setTimeout(() => {
      const el = document.getElementById(id);
      el?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
      el?.focus({ preventScroll: true });
    });
    setTimeout(() => this.highlight.set(null), 2500);
  }

  toggleInline(m: ChatMessage): void {
    this.inlineOpen.update((s) => {
      const n = new Set(s);
      if (n.has(m.localId)) n.delete(m.localId);
      else n.add(m.localId);
      return n;
    });
  }

  highlightFor(m: ChatMessage | null): number | null {
    const h = this.highlight();
    return h && m && h.localId === m.localId ? h.index : null;
  }

  basisText(m: ChatMessage): string {
    return basisSentence(m.answerBasis);
  }

  citeMode(m: ChatMessage): 'any' | ChatMessage['citations'] {
    return m.status === 'streaming' && m.citations.length === 0 ? 'any' : m.citations;
  }

  useSuggestion(s: string): void {
    if (s === 'Quiz me on this lesson') {
      this.mode.set('quiz_me');
      void this.submit('Quiz me on this lesson');
      return;
    }
    void this.submit(s);
  }

  // ------------------------------------------------------------- helpers
  private find(localId: string): ChatMessage | undefined {
    return this.messages().find((m) => m.localId === localId);
  }
  private patch(localId: string, patch: Partial<ChatMessage>): void {
    this.messages.update((l) => l.map((m) => (m.localId === localId ? { ...m, ...patch } : m)));
  }
  private armSlow(localId: string): void {
    this.clearSlow();
    this.slowTimer = setTimeout(() => {
      const m = this.find(localId);
      if (m?.status === 'streaming' && !m.content) this.patch(localId, { slow: true });
    }, SLOW_MS);
  }
  private clearSlow(): void {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
  }
  private scrollToBottom(force = false): void {
    setTimeout(() => {
      const el = this.scroller()?.nativeElement;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      if (force || nearBottom) el.scrollTop = el.scrollHeight;
    });
  }

  setLevel(value: string): void {
    if (value === 'beginner' || value === 'intermediate' || value === 'advanced') this.level.set(value);
  }
}
