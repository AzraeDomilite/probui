#!/usr/bin/env node
/*
 * ui-bridge: loopback HTTP bridge between the UiProbe overlay and Claude Code.
 *
 * Endpoints:
 *   POST /ui-prompt                  create an event, return 201 {eventId}
 *                                    + emit [ui-prompt] {...} on stdout
 *   POST /ui-prompt/<id>/status      Claude pushes {status, message?, filePath?}
 *   GET  /ui-prompt/<id>/events      SSE stream of status updates
 *   GET  /ui-prompt/<id>             current state as JSON (simple polling)
 *   GET  /ui-prompt/<id>/screenshot  attached PNG as a data URL (text/plain)
 *
 * Run: node ui-bridge.mjs    (port 8766, override with UI_BRIDGE_PORT)
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.UI_BRIDGE_PORT) || 8766;

// Common dev-server ports: Vite (5173–5175 and preview 4173), CRA/Next (3000),
// VS Code Live Server (5500), generic container (8080); both localhost and
// 127.0.0.1 variants. Add your dev server here if it runs elsewhere.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5175',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
]);

// Volatile store; FIFO-trimmed to MAX_EVENTS. A restart wipes everything.
const EVENTS = new Map();
const MAX_EVENTS = 100;
const BODY_LIMIT = 4 * 1024 * 1024;
const SCREENSHOT_LIMIT = 3 * 1024 * 1024;

function emitNew(evt) {
  // The screenshot never goes to stdout (would flood the Claude chat). We expose
  // a bool instead, and Claude can fetch the PNG via GET /ui-prompt/<id>/screenshot.
  const line = {
    eventId: evt.eventId,
    t: evt.t,
    prompt: evt.prompt,
    selector: evt.selector,
    url: evt.url,
    excerpt: evt.excerpt,
    viewport: evt.viewport,
    hasScreenshot: !!evt.screenshot,
  };
  process.stdout.write(`[ui-prompt] ${JSON.stringify(line)}\n`);
}

function pushToSubscribers(evt, data) {
  for (const res of evt.subscribers) {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // socket closed on the client; cleaned up in req.on('close')
    }
  }
}

function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'http://localhost:5173';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
  };
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function respondJSON(res, code, data, origin) {
  res.writeHead(code, { 'content-type': 'application/json', ...corsHeaders(origin) });
  res.end(JSON.stringify(data));
}

async function handleCreate(req, res, origin) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return respondJSON(res, 413, { error: 'body too large' }, origin);
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    return respondJSON(res, 400, { error: 'invalid JSON', detail: String(err) }, origin);
  }
  const screenshot =
    typeof data.screenshot === 'string' && data.screenshot.length <= SCREENSHOT_LIMIT
      ? data.screenshot
      : null;
  const evt = {
    eventId: randomUUID(),
    t: new Date().toISOString(),
    prompt: typeof data.prompt === 'string' ? data.prompt.slice(0, 4000) : '',
    selector: typeof data.selector === 'string' ? data.selector.slice(0, 500) : '',
    url: typeof data.url === 'string' ? data.url.slice(0, 500) : '',
    excerpt: typeof data.excerpt === 'string' ? data.excerpt.slice(0, 2000) : '',
    viewport: data.viewport && typeof data.viewport === 'object' ? data.viewport : null,
    screenshot,
    status: 'pending',
    message: '',
    filePath: '',
    createdAt: Date.now(),
    subscribers: [],
  };
  if (!evt.prompt) {
    return respondJSON(res, 400, { error: 'empty prompt' }, origin);
  }
  while (EVENTS.size >= MAX_EVENTS) {
    const oldestKey = EVENTS.keys().next().value;
    const ev = EVENTS.get(oldestKey);
    for (const subscriber of ev.subscribers) {
      try {
        subscriber.end();
      } catch {
        /* ignore */
      }
    }
    EVENTS.delete(oldestKey);
  }
  EVENTS.set(evt.eventId, evt);
  emitNew(evt);
  return respondJSON(res, 201, { eventId: evt.eventId }, origin);
}

async function handleStatus(evt, req, res, origin) {
  let body;
  try {
    body = await readBody(req, 64 * 1024);
  } catch {
    return respondJSON(res, 413, { error: 'body too large' }, origin);
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    return respondJSON(res, 400, { error: 'invalid JSON', detail: String(err) }, origin);
  }
  if (typeof data.status === 'string') evt.status = data.status.slice(0, 32);
  if (typeof data.message === 'string') evt.message = data.message.slice(0, 1000);
  if (typeof data.filePath === 'string') evt.filePath = data.filePath.slice(0, 500);
  pushToSubscribers(evt, {
    status: evt.status,
    message: evt.message,
    filePath: evt.filePath,
  });
  res.writeHead(204, corsHeaders(origin));
  res.end();
}

function handleSSE(evt, req, res, origin) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...corsHeaders(origin),
  });
  res.write(
    `data: ${JSON.stringify({ status: evt.status, message: evt.message, filePath: evt.filePath })}\n\n`,
  );
  evt.subscribers.push(res);
  req.on('close', () => {
    evt.subscribers = evt.subscribers.filter((s) => s !== res);
  });
}

function handleGetStatus(evt, res, origin) {
  return respondJSON(
    res,
    200,
    {
      eventId: evt.eventId,
      status: evt.status,
      message: evt.message,
      filePath: evt.filePath,
      hasScreenshot: !!evt.screenshot,
    },
    origin,
  );
}

function handleGetScreenshot(evt, res, origin) {
  if (!evt.screenshot) {
    return respondJSON(res, 404, { error: 'no screenshot for this event' }, origin);
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders(origin) });
  res.end(evt.screenshot);
}

const regexStatus = /^\/ui-prompt\/([0-9a-f-]{32,36})\/status$/;
const regexEvents = /^\/ui-prompt\/([0-9a-f-]{32,36})\/events$/;
const regexScreenshot = /^\/ui-prompt\/([0-9a-f-]{32,36})\/screenshot$/;
const regexEvent = /^\/ui-prompt\/([0-9a-f-]{32,36})$/;

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }
  const url = req.url || '';
  if (req.method === 'POST' && url === '/ui-prompt') {
    void handleCreate(req, res, origin);
    return;
  }
  const mStatus = url.match(regexStatus);
  if (mStatus) {
    const evt = EVENTS.get(mStatus[1]);
    if (!evt) return respondJSON(res, 404, { error: 'unknown event' }, origin);
    if (req.method === 'POST') return void handleStatus(evt, req, res, origin);
  }
  const mEvents = url.match(regexEvents);
  if (mEvents && req.method === 'GET') {
    const evt = EVENTS.get(mEvents[1]);
    if (!evt) return respondJSON(res, 404, { error: 'unknown event' }, origin);
    return handleSSE(evt, req, res, origin);
  }
  const mScreenshot = url.match(regexScreenshot);
  if (mScreenshot && req.method === 'GET') {
    const evt = EVENTS.get(mScreenshot[1]);
    if (!evt) return respondJSON(res, 404, { error: 'unknown event' }, origin);
    return handleGetScreenshot(evt, res, origin);
  }
  const mEvt = url.match(regexEvent);
  if (mEvt && req.method === 'GET') {
    const evt = EVENTS.get(mEvt[1]);
    if (!evt) return respondJSON(res, 404, { error: 'unknown event' }, origin);
    return handleGetStatus(evt, res, origin);
  }
  res.writeHead(404, corsHeaders(origin));
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[ui-bridge] listening on 127.0.0.1:${PORT} (SSE + screenshot + status)\n`);
});
