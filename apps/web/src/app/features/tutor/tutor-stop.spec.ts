import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER, Observable, of, Subject } from 'rxjs';
import { LearningApi } from '../../core/api/learning.api';
import { TutorApi } from '../../core/api/tutor.api';
import { AuthStore } from '../../core/auth/auth.store';
import { Conversation, ConversationCreated, Message, TutorEvent } from '../../core/models/api.models';
import { fromHistory, INTERRUPTED_MESSAGE, isStreaming, STOPPED_NOTICE } from './chat-message';
import TutorComponent, { STOP_DRAIN_MS } from './tutor.component';

/** Controllable fake of the tutor API: every stream is a Subject we drive by hand. */
class FakeTutorApi {
  created = new Subject<ConversationCreated>();
  streams: { convId: string; events: Subject<TutorEvent>; unsubscribed: boolean }[] = [];
  cancels: { convId: string; messageId: string }[] = [];
  conversationResult: Conversation | null = null;

  create(): Observable<ConversationCreated> {
    return this.created;
  }
  stream(convId: string): Observable<TutorEvent> {
    const events = new Subject<TutorEvent>();
    const entry = { convId, events, unsubscribed: false };
    this.streams.push(entry);
    return new Observable<TutorEvent>((sub) => {
      const s = events.subscribe(sub);
      return () => {
        entry.unsubscribed = true; // ≙ SseClient aborting the fetch
        s.unsubscribe();
      };
    });
  }
  cancel(convId: string, messageId: string): Observable<void> {
    this.cancels.push({ convId, messageId });
    return of(undefined);
  }
  conversation(): Observable<Conversation> {
    return of(this.conversationResult!);
  }
  conversations() {
    return NEVER;
  }
  feedback() {
    return of(undefined);
  }
}

const START: TutorEvent = { event: 'start', data: { conversationId: 'c1', userMessageId: 'u1', assistantMessageId: 'a1', runId: 'r1', referenceId: '7F3A-91C2' } };

function msg(role: 'user' | 'assistant', extra: Partial<Message> = {}): Message {
  return { id: `${role}-${Math.random()}`, role, content: role === 'user' ? 'What is attention?' : 'Attention lets', level: 'beginner', mode: 'explain', adjust: null, webSearch: false, citations: [], answerBasis: [], status: 'complete', errorCode: null, referenceId: null, feedback: null, createdAt: '2026-10-20T10:00:00Z', ...extra };
}

describe('tutor Stop', () => {
  let api: FakeTutorApi;

  beforeEach(() => {
    api = new FakeTutorApi();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: TutorApi, useValue: api },
        { provide: LearningApi, useValue: { lesson: () => NEVER } },
        { provide: AuthStore, useValue: { me: signal(null), activeCourseId: signal('crs-1') } },
      ],
    });
  });

  function create() {
    const fixture = TestBed.createComponent(TutorComponent);
    return fixture.componentInstance;
  }
  const answer = (c: TutorComponent) => c.messages().find((m) => m.role === 'assistant')!;
  const flush = () => new Promise((r) => setTimeout(r));

  it('stops while the conversation is still being created: no stream is ever opened', async () => {
    const c = create();
    void c.submit('Why divide by root d?');
    await flush();
    expect(c.streaming()).toBe(true);
    expect(answer(c).statusText).toBe('Connecting…');

    c.stop();
    expect(c.streaming()).toBe(false); // the composer unlocks at once
    expect(answer(c).status).toBe('cancelled');
    expect(answer(c).notice).toBe(STOPPED_NOTICE);

    api.created.next({ id: 'c1', title: 'New', courseId: 'crs-1', lessonId: null, createdAt: '' });
    await flush();
    expect(api.streams.length).toBe(0);
    expect(api.cancels.length).toBe(0);
    expect(c.conversationId()).toBe('c1'); // the next question goes into the same conversation
  });

  it('stops before `start`: ends locally now, then cancels and aborts as soon as `start` brings the id', async () => {
    const c = create();
    c.conversationId.set('c1');
    void c.submit('Why divide by root d?');
    await flush();
    expect(api.streams.length).toBe(1);

    c.stop();
    expect(c.streaming()).toBe(false);
    expect(answer(c).status).toBe('cancelled');
    expect(api.cancels).toEqual([]);
    expect(api.streams[0].unsubscribed).toBe(false); // still listening, only for the id

    api.streams[0].events.next(START);
    expect(api.cancels).toEqual([{ convId: 'c1', messageId: 'a1' }]);
    expect(api.streams[0].unsubscribed).toBe(true);
    expect(answer(c).id).toBe('a1');
    expect(answer(c).status).toBe('cancelled'); // late events never revive it
  });

  it('gives up waiting for `start` after a while and aborts anyway', async () => {
    vi.useFakeTimers();
    try {
      const c = create();
      c.conversationId.set('c1');
      void c.submit('Hello');
      await vi.advanceTimersByTimeAsync(1);
      c.stop();
      await vi.advanceTimersByTimeAsync(STOP_DRAIN_MS + 10);
      expect(api.streams[0].unsubscribed).toBe(true);
      expect(api.cancels).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops after `start`: cancels immediately, aborts the fetch and keeps the text so far', async () => {
    const c = create();
    c.conversationId.set('c1');
    void c.submit('Why divide by root d?');
    await flush();
    api.streams[0].events.next(START);
    api.streams[0].events.next({ event: 'token', data: { text: 'Dot products grow ' } });

    c.stop();
    expect(api.cancels).toEqual([{ convId: 'c1', messageId: 'a1' }]);
    expect(api.streams[0].unsubscribed).toBe(true);
    expect(answer(c).content).toBe('Dot products grow ');
    expect(answer(c).status).toBe('cancelled');
    expect(answer(c).error).toBeNull();
    expect(c.canSend()).toBe(false); // empty draft
    c.draft.set('Next question');
    expect(c.canSend()).toBe(true);
  });

  it('a stuck `streaming` answer loaded from history never locks the composer, and can be stopped', async () => {
    api.conversationResult = { id: 'c9', title: 'MoE', courseId: 'crs-1', lessonId: null, lessonTitle: null, messages: [msg('user'), msg('assistant', { id: 'a9', status: 'streaming' })] };
    const c = create();
    await c.open('c9');
    expect(c.streaming()).toBe(false);
    c.draft.set('Another question');
    expect(c.canSend()).toBe(true);

    const stuck = answer(c);
    expect(stuck.serverStreaming).toBe(true);
    c.stopServerAnswer(stuck);
    expect(api.cancels).toEqual([{ convId: 'c9', messageId: 'a9' }]);
    expect(answer(c).status).toBe('cancelled');
    expect(answer(c).serverStreaming).toBe(false);
  });

  it('treats a `done` with status "cancelled" (cancelled elsewhere) as stopped, not complete', async () => {
    const c = create();
    c.conversationId.set('c1');
    void c.submit('Hello');
    await flush();
    api.streams[0].events.next(START);
    api.streams[0].events.next({ event: 'token', data: { text: 'Partial ' } });
    api.streams[0].events.next({ event: 'done', data: { messageId: 'a1', content: 'Partial', answerBasis: [], citationsValid: 0, citationsDropped: 0, warnings: ['CANCELLED'], status: 'cancelled' } });
    expect(answer(c).status).toBe('cancelled');
    expect(answer(c).notice).toBe(STOPPED_NOTICE);
    expect(answer(c).content).toBe('Partial');
    expect(c.streaming()).toBe(false);
  });

  it('Stop with nothing running still unlocks anything marked streaming', () => {
    const c = create();
    c.messages.set(fromHistory([msg('user')]).concat([{ ...fromHistory([msg('assistant')])[0], status: 'streaming' }]));
    expect(c.streaming()).toBe(true);
    c.stop();
    expect(c.streaming()).toBe(false);
  });

  it('New conversation keeps the level and clears the messages', async () => {
    const c = create();
    c.level.set('advanced');
    c.conversationId.set('c1');
    c.messages.set(fromHistory([msg('user'), msg('assistant')]));
    expect(c.canStartNew()).toBe(true);
    c.newConversation();
    expect(c.messages()).toEqual([]);
    expect(c.conversationId()).toBeNull();
    expect(c.level()).toBe('advanced');
  });
});

describe('tutor history mapping', () => {
  it('maps cancelled answers to "You stopped this answer." with Ask again', () => {
    const list = fromHistory([msg('user'), msg('assistant', { status: 'cancelled' })]);
    expect(list[1].notice).toBe(STOPPED_NOTICE);
    expect(list[1].request).toEqual({ content: 'What is attention?', level: 'beginner', mode: 'explain', webSearch: false });
    expect(isStreaming(list)).toBe(false);
  });

  it('shows STREAM_INTERRUPTED as a friendly, retryable error', () => {
    const list = fromHistory([msg('user'), msg('assistant', { status: 'failed', errorCode: 'STREAM_INTERRUPTED', referenceId: '4C2E-9A17' })]);
    expect(list[1].error?.userMessage).toBe(INTERRUPTED_MESSAGE);
    expect(INTERRUPTED_MESSAGE).toBe('This answer was interrupted. Try again.');
    expect(list[1].error?.referenceId).toBe('4C2E-9A17');
    expect(list[1].request).not.toBeNull();
  });

  it('never keeps a loaded answer in the local streaming state', () => {
    const list = fromHistory([msg('user'), msg('assistant', { status: 'streaming' })]);
    expect(list[1].status).toBe('partial');
    expect(list[1].serverStreaming).toBe(true);
    expect(isStreaming(list)).toBe(false);
  });

  it('does not offer Retry for Simpler/Harder follow-ups (no original text to resend)', () => {
    const list = fromHistory([msg('user', { adjust: 'simpler', content: 'Explain that more simply' }), msg('assistant', { status: 'failed', errorCode: 'LLM_TIMEOUT' })]);
    expect(list[1].request).toBeNull();
  });
});
