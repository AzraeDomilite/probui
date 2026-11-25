/*
 * UiProbe: React overlay. Click an element on the page, type a prompt,
 * press Cmd+Enter, and the payload is sent to `ui-bridge.mjs`, which emits
 * it on stdout for Claude Code. The popup then listens over SSE for the
 * status Claude pushes back. Mounted in dev only from main.tsx; the dynamic
 * import is stripped by `vite build` unless the `VITE_UI_PROBE=1` flag is set.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Default bridge URL comes from the build (VITE_UI_BRIDGE_URL) but the user
// can override it at runtime via the popup settings — persisted per browser.
const URL_BRIDGE_DEFAULT =
  (import.meta.env && (import.meta.env.VITE_UI_BRIDGE_URL as string | undefined)) ||
  'http://127.0.0.1:8766';
const KEY_PROMPTS = 'probui.recent_prompts.v1';
const KEY_CAPTURE = 'probui.capture_enabled.v1';
const KEY_AUTHOR = 'probui.author.v1';
const KEY_BRIDGE_URL = 'probui.bridge_url.v1';
const KEY_TOKEN = 'probui.token.v1';

function bridgeRoot(bridgeUrl: string): string {
  return (bridgeUrl || URL_BRIDGE_DEFAULT).replace(/\/+$/, '');
}

function bridgeFetch(
  bridgeUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return fetch(`${bridgeRoot(bridgeUrl)}${path}`, { ...init, headers });
}
const HTML2CANVAS_CDN = 'https://esm.sh/html2canvas@1.4.1';
const MAX_RECENT_PROMPTS = 10;
const HISTORY_POLL_MS = 2000;

type Html2Canvas = (
  el: HTMLElement,
  opts?: { backgroundColor?: string | null; scale?: number; useCORS?: boolean },
) => Promise<HTMLCanvasElement>;

interface Selection {
  element: Element;
  selector: string;
  excerpt: string;
  rect: DOMRect;
}

type State = 'idle' | 'sending' | 'sent' | 'error';

interface HistoryEvent {
  eventId: string;
  t: string;
  author: string;
  prompt: string;
  selector: string;
  url: string;
  status: string;
  message: string;
  filePath: string;
  hasScreenshot: boolean;
  emitted: boolean;
}

const SENT_GRACE_MS = 4000;

// Pure helper for the status pill color (also used in the history panel).
// Three canonical states : waiting (cancel window), running (Claude acting),
// done/error/canceled (terminal). Any custom status Claude pushes is shown
// verbatim but keeps the 'running' palette.
function statusTone(status: string, emitted: boolean): { label: string; bg: string; fg: string } {
  if (!emitted && status === 'pending') {
    return { label: 'waiting', bg: 'rgba(146,176,250,0.12)', fg: '#92b0fa' };
  }
  if (status === 'done' || status === 'ok') {
    return { label: 'done', bg: 'rgba(120,217,120,0.15)', fg: '#78d978' };
  }
  if (status === 'error') {
    return { label: 'error', bg: 'rgba(255,78,65,0.15)', fg: '#ff4e41' };
  }
  if (status === 'canceled') {
    return { label: 'canceled', bg: 'rgba(146,176,250,0.08)', fg: '#92b0fa' };
  }
  if (status === 'dispatched') {
    return { label: 'running', bg: 'rgba(99,136,227,0.2)', fg: '#6388e3' };
  }
  return { label: status || 'running', bg: 'rgba(99,136,227,0.2)', fg: '#6388e3' };
}

function buildSelector(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let guard = 0;
  while (cur && cur !== document.body && guard++ < 8) {
    const node: Element = cur;
    if (node.id) {
      parts.unshift(`#${node.id}`);
      break;
    }
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    let piece = tag;
    if (parent) {
      const siblings: Element[] = Array.from(parent.children).filter(
        (c: Element) => c.tagName === node.tagName,
      );
      if (siblings.length > 1) {
        const i = siblings.indexOf(node) + 1;
        piece += `:nth-of-type(${i})`;
      }
    }
    const semanticClass = Array.from(node.classList).find(
      (c: string) => !/^[a-z-]+-/.test(c) && c.length < 32,
    );
    if (semanticClass) piece += `.${semanticClass}`;
    parts.unshift(piece);
    cur = parent;
  }
  return parts.join(' > ') || el.tagName.toLowerCase();
}

function htmlExcerpt(el: Element): string {
  const html = el.outerHTML;
  return html.length <= 1500 ? html : html.slice(0, 1500) + '…';
}

function firstChildElement(el: Element): Element | null {
  for (const child of Array.from(el.children)) {
    if (!(child instanceof Element)) continue;
    if (child.closest('[data-ui-probe]')) continue;
    return child;
  }
  return null;
}

function navigableParent(el: Element): Element | null {
  const parent = el.parentElement;
  if (!parent || parent === document.body || parent === document.documentElement) return null;
  return parent;
}

function selectionFrom(el: Element): Selection {
  return {
    element: el,
    selector: buildSelector(el),
    excerpt: htmlExcerpt(el),
    rect: el.getBoundingClientRect(),
  };
}

function readLocalStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeLocalStorage<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* no quota, no storage, ignore */
  }
}

let html2canvasCache: Promise<Html2Canvas> | null = null;
function loadHtml2Canvas(): Promise<Html2Canvas> {
  if (!html2canvasCache) {
    html2canvasCache = import(/* @vite-ignore */ HTML2CANVAS_CDN).then(
      (mod) => (mod.default as Html2Canvas) || (mod as unknown as Html2Canvas),
    );
  }
  return html2canvasCache;
}

async function captureElement(el: Element): Promise<string | null> {
  if (!(el instanceof HTMLElement)) return null;
  try {
    const h2c = await loadHtml2Canvas();
    const canvas = await h2c(el, { backgroundColor: null, scale: 1, useCORS: true });
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.warn('[probui] capture failed', err);
    return null;
  }
}

function Outline({ rect }: { rect: DOMRect }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        border: '2px solid #6388e3',
        borderRadius: 4,
        background: 'rgba(99,136,227,0.08)',
        pointerEvents: 'none',
        zIndex: 2147483646,
        transition: 'all 80ms linear',
      }}
    />
  );
}

const navButtonStyle = {
  padding: '4px 8px',
  borderRadius: 4,
  border: '1px solid rgba(146,176,250,0.3)',
  background: 'rgba(3,13,32,0.6)',
  color: '#92b0fa',
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: '"Kode Mono", monospace',
  minWidth: 28,
} as const;

export function UiProbe() {
  const [active, setActive] = useState(false);
  const [hover, setHover] = useState<Element | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [prompt, setPrompt] = useState('');
  const [state, setState] = useState<State>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [capture, setCapture] = useState(() => readLocalStorage<boolean>(KEY_CAPTURE, false));
  const [recents, setRecents] = useState<string[]>(() => readLocalStorage<string[]>(KEY_PROMPTS, []));
  const [author, setAuthor] = useState(() => readLocalStorage<string>(KEY_AUTHOR, ''));
  const [bridgeUrl, setBridgeUrl] = useState(() => readLocalStorage<string>(KEY_BRIDGE_URL, ''));
  const [token, setToken] = useState(() => readLocalStorage<string>(KEY_TOKEN, ''));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [eventId, setEventId] = useState<string | null>(null);
  const [rectTick, setRectTick] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEvents, setHistoryEvents] = useState<HistoryEvent[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    writeLocalStorage(KEY_CAPTURE, capture);
  }, [capture]);

  useEffect(() => {
    writeLocalStorage(KEY_AUTHOR, author);
  }, [author]);

  useEffect(() => {
    writeLocalStorage(KEY_BRIDGE_URL, bridgeUrl);
  }, [bridgeUrl]);

  useEffect(() => {
    writeLocalStorage(KEY_TOKEN, token);
  }, [token]);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 'U' || e.key === 'u')) {
        setActive((v) => !v);
        setSelection(null);
        setEventId(null);
        setState('idle');
      }
      if (e.key === 'Escape') {
        setActive(false);
        setSelection(null);
        setHover(null);
      }
    };
    window.addEventListener('keydown', kd);
    return () => window.removeEventListener('keydown', kd);
  }, []);

  useEffect(() => {
    if (!active || selection) return;
    function onMove(e: MouseEvent) {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target.closest('[data-ui-probe]')) return;
      setHover(target);
    }
    function onClick(e: MouseEvent) {
      if (!active || selection) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target.closest('[data-ui-probe]')) return;
      e.preventDefault();
      e.stopPropagation();
      setSelection(selectionFrom(target));
      setHover(null);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('click', onClick, true);
    };
  }, [active, selection]);

  useEffect(() => {
    if (selection && textareaRef.current) textareaRef.current.focus();
  }, [selection]);

  // Keep the outline's rect in sync with scroll, resize and parent/child jumps.
  useEffect(() => {
    if (!selection) return;
    const update = () => setRectTick((n) => n + 1);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [selection]);

  const currentRect = useMemo(() => {
    if (!selection) return null;
    void rectTick;
    return selection.element.getBoundingClientRect();
  }, [selection, rectTick]);

  const goToParent = useCallback(() => {
    if (!selection) return;
    const parent = navigableParent(selection.element);
    if (parent) setSelection(selectionFrom(parent));
  }, [selection]);

  const goToChild = useCallback(() => {
    if (!selection) return;
    const child = firstChildElement(selection.element);
    if (child) setSelection(selectionFrom(child));
  }, [selection]);

  const send = useCallback(async () => {
    if (!selection || !prompt.trim()) return;
    setState('sending');
    setErrorMsg(null);
    setEventId(null);
    let dataURL: string | null = null;
    if (capture) {
      dataURL = await captureElement(selection.element);
    }
    try {
      const response = await bridgeFetch(bridgeUrl, token, '/ui-prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: author.trim(),
          prompt: prompt.trim(),
          selector: selection.selector,
          url: window.location.href,
          excerpt: selection.excerpt,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          screenshot: dataURL,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { eventId?: string };
      const next = [prompt.trim(), ...recents.filter((p) => p !== prompt.trim())].slice(
        0,
        MAX_RECENT_PROMPTS,
      );
      setRecents(next);
      writeLocalStorage(KEY_PROMPTS, next);
      // Grace window: the card stays visible for a few seconds with a cancel
      // button, so the user can undo an unintended send. After the delay the
      // popup closes and the probe switches off on its own.
      if (body.eventId) setEventId(body.eventId);
      setState('sent');
    } catch (e: unknown) {
      setState('error');
      setErrorMsg(String(e));
    }
  }, [selection, prompt, capture, recents, author, bridgeUrl, token]);

  const resetAll = useCallback(() => {
    setSelection(null);
    setPrompt('');
    setState('idle');
    setEventId(null);
    setErrorMsg(null);
    setActive(false);
  }, []);

  const cancelSend = useCallback(async () => {
    if (eventId) {
      try {
        await bridgeFetch(bridgeUrl, token, `/ui-prompt/${eventId}/cancel`, { method: 'POST' });
      } catch {
        /* best-effort: close anyway */
      }
    }
    resetAll();
  }, [eventId, resetAll, bridgeUrl, token]);

  // Auto-close after the grace window if the user doesn't cancel.
  useEffect(() => {
    if (state !== 'sent') return;
    const t = window.setTimeout(resetAll, SENT_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [state, resetAll]);

  const closePopup = useCallback(() => {
    setSelection(null);
    setPrompt('');
    setState('idle');
    setEventId(null);
    setErrorMsg(null);
  }, []);

  // Poll the bridge when the history panel is open. 2 s cadence is enough
  // for Claude's status pushes to feel live without flooding the loopback.
  useEffect(() => {
    if (!historyOpen) return;
    let alive = true;
    const load = async () => {
      try {
        const resp = await bridgeFetch(bridgeUrl, token, '/ui-prompts');
        if (!resp.ok) return;
        const body = (await resp.json()) as { events?: HistoryEvent[] };
        if (alive) setHistoryEvents(body.events ?? []);
      } catch {
        /* bridge down : keep previous snapshot */
      }
    };
    void load();
    const t = window.setInterval(load, HISTORY_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [historyOpen, bridgeUrl, token]);

  const button = useMemo(
    () => (
      <button
        type="button"
        data-ui-probe
        onClick={() => setActive((v) => !v)}
        title="Alt+U: toggle UI probe"
        style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          zIndex: 2147483646,
          padding: '8px 14px',
          borderRadius: 999,
          border: `1px solid ${active ? '#6388e3' : 'rgba(255,255,255,0.3)'}`,
          background: active ? '#6388e3' : 'rgba(10,30,65,0.8)',
          color: active ? '#030d20' : '#edf2ff',
          fontFamily: '"Kode Mono", monospace',
          fontSize: 12,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          cursor: 'pointer',
          backdropFilter: 'blur(8px)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}
      >
        {active ? '⏻ probe on' : '◉ probe UI'}
      </button>
    ),
    [active],
  );

  const historyButton = useMemo(
    () => (
      <button
        type="button"
        data-ui-probe
        onClick={() => setHistoryOpen((v) => !v)}
        title="Toggle the history panel"
        style={{
          position: 'fixed',
          bottom: 16,
          right: 150,
          zIndex: 2147483646,
          padding: '8px 12px',
          borderRadius: 999,
          border: `1px solid ${historyOpen ? '#6388e3' : 'rgba(255,255,255,0.3)'}`,
          background: historyOpen ? '#6388e3' : 'rgba(10,30,65,0.8)',
          color: historyOpen ? '#030d20' : '#edf2ff',
          fontFamily: '"Kode Mono", monospace',
          fontSize: 12,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          cursor: 'pointer',
          backdropFilter: 'blur(8px)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}
      >
        ≡ history
      </button>
    ),
    [historyOpen],
  );

  const settingsButton = useMemo(
    () => (
      <button
        type="button"
        data-ui-probe
        onClick={() => setSettingsOpen((v) => !v)}
        title="Bridge URL and token"
        style={{
          position: 'fixed',
          bottom: 16,
          right: 260,
          zIndex: 2147483646,
          padding: '8px 12px',
          borderRadius: 999,
          border: `1px solid ${settingsOpen ? '#6388e3' : 'rgba(255,255,255,0.3)'}`,
          background: settingsOpen ? '#6388e3' : 'rgba(10,30,65,0.8)',
          color: settingsOpen ? '#030d20' : '#edf2ff',
          fontFamily: '"Kode Mono", monospace',
          fontSize: 12,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          cursor: 'pointer',
          backdropFilter: 'blur(8px)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}
      >
        ⚙ bridge
      </button>
    ),
    [settingsOpen],
  );

  return (
    <div data-ui-probe>
      {button}
      {historyButton}
      {settingsButton}
      {settingsOpen && (
        <aside
          data-ui-probe
          role="dialog"
          aria-label="UI probe bridge settings"
          style={{
            position: 'fixed',
            bottom: 72,
            right: 16,
            zIndex: 2147483647,
            width: 420,
            maxWidth: 'calc(100vw - 32px)',
            padding: 16,
            borderRadius: 8,
            border: '1px solid #6388e3',
            background: 'rgba(3,13,32,0.95)',
            color: '#edf2ff',
            fontFamily: 'Lato, system-ui, sans-serif',
            fontSize: 13,
            backdropFilter: 'blur(12px)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}
        >
          <header
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: 12,
            }}
          >
            <span
              style={{
                fontFamily: '"Kode Mono", monospace',
                fontSize: 11,
                color: '#92b0fa',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              Bridge connection
            </span>
            <button
              type="button"
              data-ui-probe
              onClick={() => setSettingsOpen(false)}
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'transparent',
                color: '#edf2ff',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              close
            </button>
          </header>
          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              marginBottom: 10,
              fontSize: 11,
              color: '#92b0fa',
              fontFamily: '"Kode Mono", monospace',
            }}
          >
            <span>bridge URL (overrides VITE_UI_BRIDGE_URL)</span>
            <input
              type="text"
              data-ui-probe
              value={bridgeUrl}
              onChange={(e) => setBridgeUrl(e.target.value)}
              placeholder={URL_BRIDGE_DEFAULT}
              style={{
                padding: '5px 8px',
                borderRadius: 4,
                border: '1px solid rgba(146,176,250,0.3)',
                background: 'rgba(3,13,32,0.8)',
                color: '#edf2ff',
                fontFamily: 'inherit',
                fontSize: 12,
              }}
            />
          </label>
          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              marginBottom: 10,
              fontSize: 11,
              color: '#92b0fa',
              fontFamily: '"Kode Mono", monospace',
            }}
          >
            <span>token (sent as Authorization: Bearer ...)</span>
            <input
              type="password"
              data-ui-probe
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="leave empty if the bridge has no auth"
              autoComplete="off"
              style={{
                padding: '5px 8px',
                borderRadius: 4,
                border: '1px solid rgba(146,176,250,0.3)',
                background: 'rgba(3,13,32,0.8)',
                color: '#edf2ff',
                fontFamily: 'inherit',
                fontSize: 12,
              }}
            />
          </label>
          <p style={{ fontSize: 11, color: '#92b0fa', margin: 0, fontStyle: 'italic' }}>
            Values are persisted in localStorage per browser. Leave the URL
            empty to fall back to the compile-time default.
          </p>
        </aside>
      )}
      {historyOpen && (
        <aside
          data-ui-probe
          role="dialog"
          aria-label="UI probe history"
          style={{
            position: 'fixed',
            bottom: 72,
            right: 16,
            zIndex: 2147483646,
            width: 420,
            maxWidth: 'calc(100vw - 32px)',
            maxHeight: 'calc(100vh - 128px)',
            overflow: 'auto',
            padding: 14,
            borderRadius: 8,
            border: '1px solid #6388e3',
            background: 'rgba(3,13,32,0.95)',
            color: '#edf2ff',
            fontFamily: 'Lato, system-ui, sans-serif',
            fontSize: 13,
            backdropFilter: 'blur(12px)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}
        >
          <header
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: 10,
            }}
          >
            <span
              style={{
                fontFamily: '"Kode Mono", monospace',
                fontSize: 11,
                color: '#92b0fa',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              History · {historyEvents.length}
            </span>
            <button
              type="button"
              data-ui-probe
              onClick={() => setHistoryOpen(false)}
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'transparent',
                color: '#edf2ff',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              close
            </button>
          </header>
          {historyEvents.length === 0 ? (
            <p style={{ fontSize: 12, color: '#92b0fa', margin: 0 }}>
              No events yet — send one from the UI probe.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {historyEvents.map((evt) => {
                const tone = statusTone(evt.status, evt.emitted);
                return (
                  <li
                    key={evt.eventId}
                    style={{
                      padding: 10,
                      borderRadius: 4,
                      border: '1px solid rgba(146,176,250,0.2)',
                      background: 'rgba(3,13,32,0.6)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: 999,
                          background: tone.bg,
                          color: tone.fg,
                          fontFamily: '"Kode Mono", monospace',
                          fontSize: 10,
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                        }}
                      >
                        {tone.label}
                      </span>
                      <time
                        dateTime={evt.t}
                        style={{ fontSize: 11, color: '#92b0fa', fontFamily: '"Kode Mono", monospace' }}
                      >
                        {new Date(evt.t).toLocaleTimeString()}
                      </time>
                      <span
                        style={{
                          fontSize: 11,
                          color: evt.author ? '#edf2ff' : '#92b0fa',
                          fontFamily: '"Kode Mono", monospace',
                          fontStyle: evt.author ? 'normal' : 'italic',
                        }}
                        title={evt.author ? 'author' : 'no author set'}
                      >
                        {evt.author || 'anonymous'}
                      </span>
                      {evt.hasScreenshot && (
                        <span style={{ fontSize: 10, color: '#92b0fa' }} title="screenshot attached">
                          📷
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        lineHeight: 1.4,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {evt.prompt.length > 180 ? evt.prompt.slice(0, 179) + '…' : evt.prompt}
                    </div>
                    {evt.selector && (
                      <div
                        style={{
                          fontFamily: '"Kode Mono", monospace',
                          fontSize: 11,
                          color: '#92b0fa',
                          wordBreak: 'break-all',
                        }}
                      >
                        {evt.selector}
                      </div>
                    )}
                    {evt.filePath && (
                      <div
                        style={{
                          fontFamily: '"Kode Mono", monospace',
                          fontSize: 11,
                          color: tone.fg,
                          wordBreak: 'break-all',
                        }}
                      >
                        {evt.filePath}
                      </div>
                    )}
                    {evt.message && (
                      <div
                        style={{ fontSize: 12, color: '#92b0fa', fontStyle: 'italic', wordBreak: 'break-word' }}
                      >
                        {evt.message}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      )}
      {active && hover && !selection && <Outline rect={hover.getBoundingClientRect()} />}
      {selection && currentRect && (
        <>
          <Outline rect={currentRect} />
          <div
            data-ui-probe
            style={{
              position: 'fixed',
              bottom: 72,
              right: 16,
              zIndex: 2147483647,
              width: 440,
              maxWidth: 'calc(100vw - 32px)',
              padding: 16,
              borderRadius: 8,
              border: '1px solid #6388e3',
              background: 'rgba(3,13,32,0.95)',
              color: '#edf2ff',
              fontFamily: 'Lato, system-ui, sans-serif',
              fontSize: 13,
              backdropFilter: 'blur(12px)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
              }}
            >
              <button
                type="button"
                data-ui-probe
                onClick={goToParent}
                disabled={!navigableParent(selection.element)}
                title="Go to parent"
                style={navButtonStyle}
                aria-label="Parent"
              >
                ↑
              </button>
              <button
                type="button"
                data-ui-probe
                onClick={goToChild}
                disabled={!firstChildElement(selection.element)}
                title="Go to first child"
                style={navButtonStyle}
                aria-label="Child"
              >
                ↓
              </button>
              <div
                style={{
                  flex: 1,
                  fontFamily: '"Kode Mono", monospace',
                  fontSize: 11,
                  color: '#92b0fa',
                  wordBreak: 'break-all',
                }}
              >
                {selection.selector}
              </div>
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 8,
                fontSize: 11,
                color: '#92b0fa',
                fontFamily: '"Kode Mono", monospace',
              }}
            >
              <span style={{ letterSpacing: '0.04em' }}>author</span>
              <input
                type="text"
                data-ui-probe
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="your name"
                maxLength={80}
                style={{
                  flex: 1,
                  padding: '3px 8px',
                  borderRadius: 4,
                  border: '1px solid rgba(146,176,250,0.3)',
                  background: 'rgba(3,13,32,0.8)',
                  color: '#edf2ff',
                  fontFamily: 'inherit',
                  fontSize: 11,
                }}
              />
            </label>

            {recents.length > 0 && (
              <select
                data-ui-probe
                value=""
                onChange={(e) => {
                  if (e.target.value) setPrompt(e.target.value);
                }}
                style={{
                  width: '100%',
                  marginBottom: 8,
                  padding: '4px 6px',
                  borderRadius: 4,
                  border: '1px solid rgba(146,176,250,0.3)',
                  background: 'rgba(3,13,32,0.8)',
                  color: '#edf2ff',
                  fontFamily: 'inherit',
                  fontSize: 12,
                }}
              >
                <option value="">Recent prompts…</option>
                {recents.map((p, i) => (
                  <option key={i} value={p}>
                    {p.length > 60 ? p.slice(0, 59) + '…' : p}
                  </option>
                ))}
              </select>
            )}

            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What you want here (Cmd+Enter to send)"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void send();
                }
                if (e.key === 'Escape') closePopup();
              }}
              rows={4}
              disabled={state !== 'idle' && state !== 'error'}
              style={{
                width: '100%',
                resize: 'vertical',
                padding: 8,
                borderRadius: 4,
                border: '1px solid rgba(146,176,250,0.4)',
                background: 'rgba(3,13,32,0.8)',
                color: '#edf2ff',
                fontFamily: 'inherit',
                fontSize: 13,
              }}
            />

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginTop: 8,
                fontSize: 11,
                color: '#92b0fa',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                data-ui-probe
                checked={capture}
                onChange={(e) => setCapture(e.target.checked)}
              />
              Attach a screenshot (PNG of the element)
            </label>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 10,
                gap: 8,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color:
                    state === 'error'
                      ? '#ff4e41'
                      : state === 'sent'
                        ? '#78d978'
                        : '#92b0fa',
                  flex: 1,
                  wordBreak: 'break-word',
                }}
              >
                {state === 'sending' && 'sending…'}
                {state === 'sent' && 'sent — cancel to undo'}
                {state === 'error' && (errorMsg || 'error')}
                {state === 'idle' && 'Cmd+Enter to send'}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                {state === 'sent' ? (
                  <button
                    type="button"
                    data-ui-probe
                    onClick={() => void cancelSend()}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 4,
                      border: '1px solid rgba(255,78,65,0.5)',
                      background: 'rgba(255,78,65,0.15)',
                      color: '#ff4e41',
                      cursor: 'pointer',
                      fontWeight: 600,
                      fontSize: 12,
                    }}
                  >
                    cancel
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      data-ui-probe
                      onClick={closePopup}
                      style={{
                        padding: '6px 10px',
                        borderRadius: 4,
                        border: '1px solid rgba(255,255,255,0.2)',
                        background: 'transparent',
                        color: '#edf2ff',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                    >
                      close
                    </button>
                    <button
                      type="button"
                      data-ui-probe
                      onClick={() => void send()}
                      disabled={!prompt.trim() || state === 'sending'}
                      style={{
                        padding: '6px 12px',
                        borderRadius: 4,
                        border: 'none',
                        background: '#6388e3',
                        color: '#030d20',
                        cursor: prompt.trim() && state === 'idle' ? 'pointer' : 'not-allowed',
                        fontWeight: 600,
                        fontSize: 12,
                        opacity: state === 'sending' ? 0.6 : 1,
                      }}
                    >
                      send
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
