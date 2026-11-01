/* Mock-only: fake `fetch` that streams tutor answers as text/event-stream (contracts.md §5.3.1). */
import { AnswerBasis, Citation, Level, Message, SendMessageRequest } from '../models/api.models';
import type { FetchFn } from '../sse/sse-client.service';
import { hex, makeRun, MockDb, uid } from './mock-db';

interface Composed {
  text: string;
  citations: Citation[];
  basis: AnswerBasis[];
}

const LECTURE3: Citation = { index: 0, sourceType: 'upload', title: 'Lecture 3 notes.pdf', documentId: 'doc-lecture3', lessonId: null, page: 12, url: null, snippet: 'Scaling by the square root of the key dimension keeps the dot products from growing with d, which keeps softmax away from saturation.' };
const ATTN_BASICS: Citation = { index: 0, sourceType: 'course', title: 'Attention basics', documentId: null, lessonId: 'les-attn-basics', page: null, url: null, snippet: 'If q and k have independent components with variance 1, then q·k has variance d_k.' };
const BACKPROP: Citation = { index: 0, sourceType: 'course', title: 'Backpropagation', documentId: null, lessonId: 'les-backprop', page: null, url: null, snippet: 'Each layer takes the gradient arriving from above and multiplies it by its own local derivative.' };
const CHEATSHEET: Citation = { index: 0, sourceType: 'upload', title: 'Backprop cheatsheet.md', documentId: 'doc-cheatsheet', lessonId: null, page: null, url: null, snippet: 'dL/dW = δ · xᵀ, where δ is the gradient flowing into the layer.' };
const WEB_PAPER: Citation = { index: 0, sourceType: 'web', title: 'Attention Is All You Need', documentId: null, lessonId: null, page: null, url: 'https://arxiv.org/abs/1706.03762', snippet: 'For large values of d_k, the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients.' };
const WEB_BLOG: Citation = { index: 0, sourceType: 'web', title: 'The Illustrated Transformer', documentId: null, lessonId: null, page: null, url: 'https://jalammar.github.io/illustrated-transformer/', snippet: 'The score is divided by 8 (the square root of the dimension of the key vectors) — this leads to having more stable gradients.' };
const GENERIC_COURSE: Citation = { index: 0, sourceType: 'course', title: 'Attention mechanisms', documentId: null, lessonId: 'les-attention', page: null, url: null, snippet: 'Attention lets every token look at every other token and decide how much each one matters right now.' };

function numbered(list: Citation[]): Citation[] {
  return list.map((c, i) => ({ ...c, index: i + 1 }));
}

function compose(body: SendMessageRequest, previous: string | null): Composed {
  const q = (body.content || previous || '').toLowerCase();
  const web = body.webSearch;
  const level: Level = body.level;
  const isBackprop = /backprop|chain rule|gradient/.test(q);

  if (body.adjust === 'simpler') {
    return {
      text: isBackprop
        ? 'Imagine passing a note backwards down a line of people. Each person adds how much *they* changed things and passes it on. That running product is the gradient [1].'
        : 'Think of the scores as votes. With long vectors the votes get very loud, so one token shouts over everyone else. Dividing by $\\sqrt{d}$ turns the volume down so every token still gets heard [1].',
      citations: numbered([isBackprop ? BACKPROP : ATTN_BASICS]),
      basis: ['course'],
    };
  }
  if (body.adjust === 'harder') {
    return {
      text: isBackprop
        ? 'Formally, for $z^{(l)} = W^{(l)} a^{(l-1)}$ we have $\\delta^{(l)} = (W^{(l+1)})^\\top \\delta^{(l+1)} \\odot \\sigma\'(z^{(l)})$ and $\\frac{\\partial L}{\\partial W^{(l)}} = \\delta^{(l)} (a^{(l-1)})^\\top$ [1]. Reverse-mode differentiation costs about one extra forward pass, which is why it beats finite differences for millions of parameters [2].'
        : 'Let $q, k \\in \\mathbb{R}^{d_k}$ with i.i.d. components of mean 0 and variance 1. Then $\\operatorname{Var}(q^\\top k) = \\sum_{i=1}^{d_k} \\operatorname{Var}(q_i k_i) = d_k$ [1]. Softmax\'s Jacobian $\\operatorname{diag}(p) - pp^\\top$ vanishes as $p$ approaches one-hot, so unscaled logits with standard deviation $\\sqrt{d_k}$ starve the gradients [2]. Scaling by $1/\\sqrt{d_k}$ normalises the logit variance to 1.',
      citations: numbered(isBackprop ? [BACKPROP, CHEATSHEET] : [ATTN_BASICS, LECTURE3]),
      basis: isBackprop ? ['course', 'upload'] : ['course', 'upload'],
    };
  }
  if (body.mode === 'hint') {
    return {
      text: isBackprop
        ? 'Here’s a hint, not the answer: write the loss as a chain $L(a(z(w)))$. Which three derivatives would you multiply to get $\\partial L / \\partial w$ [1]?'
        : 'Here’s a hint: start with one pair of vectors. If each of the $d$ products $q_i k_i$ has variance 1 and they’re independent, what is the variance of their **sum** [1]?',
      citations: numbered([isBackprop ? BACKPROP : ATTN_BASICS]),
      basis: ['course'],
    };
  }
  if (body.mode === 'quiz_me') {
    return {
      text: 'Quick check — answer in one sentence:\n\n1. If $d_k = 64$, what is the standard deviation of an unscaled dot product of unit-variance vectors?\n2. What does softmax do when its inputs are very large?\n\nReply with your answers and I’ll tell you how you did [1].',
      citations: numbered([GENERIC_COURSE]),
      basis: ['course'],
    };
  }

  if (isBackprop) {
    const cites = web ? [BACKPROP, CHEATSHEET, WEB_BLOG] : [BACKPROP, CHEATSHEET];
    return {
      text:
        (level === 'beginner'
          ? 'Backpropagation works backwards from the mistake. The output layer knows how wrong it was, so it tells the layer before it how much to change, and so on [1].'
          : 'Backpropagation applies the chain rule from the output backwards: each layer multiplies the gradient arriving from above by its own local derivative, $\\frac{\\partial L}{\\partial z} = \\frac{\\partial L}{\\partial a}\\,\\sigma\'(z)$ [1].') +
        '\n\nYour cheatsheet has the matrix form: $\\frac{\\partial L}{\\partial W} = \\delta\\, x^\\top$ [2].' +
        (web ? '\n\nThe Illustrated guides show the same idea visually, layer by layer [3].' : ''),
      citations: numbered(cites),
      basis: web ? ['course', 'upload', 'web'] : ['course', 'upload'],
    };
  }

  const attnCites = web ? [LECTURE3, ATTN_BASICS, WEB_PAPER] : [LECTURE3, ATTN_BASICS];
  const intro =
    level === 'beginner'
      ? 'When vectors get longer, their dot products get bigger. Big scores make softmax pick just one token and learning slows down. Dividing by $\\sqrt{d}$ keeps the scores calm [1].'
      : level === 'advanced'
        ? 'With unit-variance components, $q^\\top k$ has variance $d_k$, so logits scale like $\\sqrt{d_k}$; softmax then saturates and its Jacobian vanishes. Scaling by $1/\\sqrt{d_k}$ restores unit variance [1].'
        : 'Dot products grow as vectors get longer, which pushes softmax toward one-hot outputs and tiny gradients. Dividing by $\\sqrt{d_k}$ keeps the scores in a stable range [1].';
  return {
    text:
      intro +
      '\n\nTry it: if each entry has variance 1, what is the variance of a dot product of length $d$? [2]' +
      (web ? '\n\nThe original Transformer paper gives exactly this reason for the scaling [3].' : ''),
    citations: numbered(attnCites),
    basis: web ? ['upload', 'course', 'web'] : ['upload', 'course'],
  };
}

const FAILED_ONCE = new Set<string>();

/** In-process registry of active runs (messageId → cancellation), like the API's (contracts.md §11.5). */
const ACTIVE_RUNS = new Map<string, AbortController>();

/** POST …/messages/{id}/cancel: stops the run if it is active here. Returns false when it isn't. */
export function cancelMockRun(messageId: string): boolean {
  const run = ACTIVE_RUNS.get(messageId);
  if (!run) return false;
  run.abort();
  return true;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

function problemResponse(status: number, code: string, title: string, detail: string, traceId: string): Response {
  const ref = traceId.slice(0, 8).toUpperCase();
  return new Response(JSON.stringify({ type: `https://sathi.app/errors/${code.toLowerCase()}`, title, status, detail, code, traceId, referenceId: `${ref.slice(0, 4)}-${ref.slice(4)}` }), {
    status,
    headers: { 'Content-Type': 'application/problem+json', 'X-Trace-Id': traceId },
  });
}

/** Wraps the real fetch: tutor stream URLs are answered locally, everything else passes through. */
export function createMockFetch(getDb: () => MockDb, realFetch: FetchFn): FetchFn {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const m = /\/api\/v1\/conversations\/([^/]+)\/messages\/stream$/.exec(url);
    if (!m || init?.method !== 'POST') return realFetch(input, init);

    const db = getDb();
    const headers = new Headers(init.headers);
    const traceId = /^00-([0-9a-f]{32})-/.exec(headers.get('traceparent') ?? '')?.[1] ?? hex(16);
    const user = db.currentUser();
    if (!user) return problemResponse(401, 'AUTH_UNAUTHENTICATED', 'Not signed in', 'Please sign in to continue.', traceId);
    const conv = db.s.conversations.find((c) => c.id === m[1] && c.userId === user.id);
    if (!conv) return problemResponse(404, 'NOT_FOUND', 'Not found', 'We couldn’t find that conversation.', traceId);
    const body = JSON.parse(String(init.body ?? '{}')) as SendMessageRequest;
    if (body.webSearch && /quota/i.test(body.content)) {
      return problemResponse(429, 'WEB_SEARCH_QUOTA_EXCEEDED', 'Daily limit reached', 'You have used today’s 20 web searches. They reset at midnight.', traceId);
    }

    // Like the API, generation keeps going if the browser disconnects; only cancel stops it.
    const browserSignal = init.signal;
    const runControl = new AbortController();
    const signal = runControl.signal;
    const encoder = new TextEncoder();
    const prev = body.replyToMessageId ? conv.messages.find((x) => x.id === body.replyToMessageId) : null;
    const composed = compose(body, prev ? (conv.messages[conv.messages.indexOf(prev) - 1]?.content ?? null) : null);
    const run = makeRun('chat', null, Date.now(), traceId);
    run.run.conversationId = conv.id;
    const ref = run.run.referenceId;

    const userMsg: Message = { id: uid(), role: 'user', content: body.adjust ? (body.adjust === 'simpler' ? 'Explain that more simply' : 'Go deeper') : body.content, level: body.level, mode: body.mode, adjust: body.adjust ?? null, webSearch: body.webSearch, citations: [], answerBasis: [], status: 'complete', errorCode: null, referenceId: null, feedback: null, createdAt: new Date().toISOString() };
    const asst: Message = { ...userMsg, id: uid(), role: 'assistant', content: '', status: 'streaming', referenceId: ref, createdAt: new Date().toISOString() };
    conv.messages.push(userMsg, asst);
    ACTIVE_RUNS.set(asst.id, runControl);
    if (conv.messages.length === 2 && body.content) conv.title = body.content.slice(0, 60);
    conv.updatedAt = new Date().toISOString();
    db.s.questionsAsked[user.id] = (db.s.questionsAsked[user.id] ?? 0) + 1;
    db.s.runs.unshift(run);
    db.save();

    const lower = body.content.toLowerCase();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let detached = false;
        browserSignal?.addEventListener('abort', () => {
          detached = true;
          try {
            controller.error(new DOMException('Aborted', 'AbortError'));
          } catch {
            /* already closed */
          }
        });
        // Emit text in irregular slices so frames straddle chunk boundaries (exercises the parser).
        let pending = '';
        const flush = (force = false) => {
          if (detached) {
            pending = '';
            return;
          }
          while (pending.length > (force ? 0 : 24)) {
            const cut = force ? pending.length : 7 + Math.floor(Math.random() * 30);
            controller.enqueue(encoder.encode(pending.slice(0, cut)));
            pending = pending.slice(cut);
          }
        };
        const close = () => {
          if (detached) return;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        const send = (event: string, data: Record<string, unknown>) => {
          pending += frame(event, { ...data, requestId: traceId.slice(0, 16) });
          flush();
        };
        const finish = (status: Message['status'], errorCode: string | null) => {
          ACTIVE_RUNS.delete(asst.id);
          asst.status = status;
          asst.errorCode = errorCode;
          conv.updatedAt = new Date().toISOString();
          db.save();
        };
        try {
          await sleep(250, signal);
          send('start', { conversationId: conv.id, userMessageId: userMsg.id, assistantMessageId: asst.id, runId: run.run.id, referenceId: ref });
          pending += ': ping\n\n';
          send('status', { stage: 'retrieving', message: 'Searching your course and notes…' });
          await sleep(700, signal);
          if (body.webSearch) {
            send('status', { stage: 'searching_web', message: 'Searching the web…' });
            await sleep(900, signal);
            send('status', { stage: 'reading_sources', message: 'Reading 3 web pages…' });
            await sleep(700, signal);
          }
          send('status', { stage: 'generating', message: 'Writing your answer…' });
          flush(true);
          if (lower.includes('slow')) await sleep(7500, signal);
          else await sleep(500, signal);

          if (lower.includes('error') && !FAILED_ONCE.has(lower)) {
            FAILED_ONCE.add(lower); // transient failure: a retry of the same question succeeds
            send('error', { code: 'LLM_UNAVAILABLE', message: 'The tutor is unavailable right now. Try again shortly.', referenceId: ref });
            flush(true);
            run.run.status = 'failed';
            run.run.errorCode = 'LLM_UNAVAILABLE';
            run.run.errorMessage = 'Primary and fallback providers returned 503.';
            run.steps[1].outcome = 'failed';
            finish('failed', 'LLM_UNAVAILABLE');
            close();
            return;
          }

          const tokens = composed.text.match(/\S+\s*/g) ?? [];
          for (let i = 0; i < tokens.length; i++) {
            const n = 1 + Math.floor(Math.random() * 2);
            const text = tokens.slice(i, i + n).join('');
            i += n - 1;
            asst.content += text;
            send('token', { text });
            if (lower.includes('drop') && i > tokens.length / 2 && !detached) {
              flush(true);
              finish('partial', null);
              controller.error(new TypeError('network error'));
              return;
            }
            await sleep(35 + Math.random() * 45, signal);
          }
          for (const c of composed.citations) send('citation', { ...c });
          send('usage', { inputTokens: 2140, outputTokens: tokens.length * 2, costUsd: 0.0312, model: 'claude-opus-5-5', ttftMs: 820, latencyMs: 3400 });
          asst.citations = composed.citations;
          asst.answerBasis = composed.basis;
          send('done', { messageId: asst.id, content: composed.text, answerBasis: composed.basis, citationsValid: composed.citations.length, citationsDropped: 0, warnings: [] });
          flush(true);
          asst.content = composed.text;
          finish('complete', null);
          close();
        } catch {
          // Cancelled (§11.5): keep the text produced so far with status `cancelled`. Like the API, a still-connected
          // browser gets a final `done` with status "cancelled" and the CANCELLED warning.
          run.run.status = 'cancelled';
          finish('cancelled', null);
          if (!detached) {
            try {
              send('done', { messageId: asst.id, content: asst.content, answerBasis: [], citationsValid: 0, citationsDropped: 0, warnings: ['CANCELLED'], status: 'cancelled' });
              flush(true);
              close();
            } catch {
              /* already closed */
            }
          }
        }
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Trace-Id': traceId } });
  };
}
