# probui — UI probe for editing a UI with Claude Code

*Portable kit. Two files, Node ≥ 18 and React 18+. A React+Vite project can integrate it in 10 minutes and let its team request UI tweaks from Claude by clicking on elements, then see live what Claude edits.*

## 1. What it is

A **floating button in the SPA** + a **loopback HTTP bridge** that turns a click on a UI element into a prompt sent to **Claude Code**. The popup then stays open and shows live the status Claude pushes back (`in_progress`, `editing`, `done`, `error`) via Server-Sent Events.

Full flow:

```
┌────────────────────┐   ① Alt+U or click the floating button
│  Browser (dev)     │   ② targeting mode: each hovered element is outlined
│  UiProbe.tsx       │   ③ click an element → popup
│                    │   ↕  ↑/↓: DOM nav parent / child
│                    │   ☑ opt-in: attach a PNG screenshot (html2canvas)
│                    │   ④ text + Cmd+Enter → POST /ui-prompt
│                    │   ← 201 {eventId}, SSE opened on /ui-prompt/<id>/events
└────────┬───────────┘
         │  HTTP loopback, 127.0.0.1:8766
         ▼
┌────────────────────┐   ⑤ bridge validates, stores, emits [ui-prompt] {...} on stdout
│  ui-bridge.mjs     │   ⑥ serves the PNG (base64) via /screenshot on demand
│  (Node, ES modules)│
└────────┬───────────┘
         │  stdout (each [ui-prompt] = one NDJSON line)
         ▼
┌────────────────────┐   ⑦ Monitor catches, Claude reads, edits the source file
│  Claude Code       │   ⑧ along the way Claude POSTs /ui-prompt/<id>/status
│  Monitor({…}) +    │       {status: "editing", filePath: "src/X.tsx"}
│  return curl       │   ⑨ bridge pushes that status to SSE subscribers → popup
└────────────────────┘       updates live.
```

A developer clicks on *any piece of the UI*, ticks *attach screenshot* if they want to attach a PNG, types "increase the spacing and italicize the title", presses Cmd+Enter. The popup stays open and shows *"editing src/components/Title.tsx"* then *"✓ done, 3 lines changed"*.

## 2. Requirements

- **Front**: React 18+, Vite (uses `import.meta.env.DEV` and dynamic imports). Written in TypeScript; if your project is plain JS, strip the annotations and rename to `.jsx`.
- **Back**: Node 18+ (ES modules + `node:http` + `node:crypto`). No npm dependencies.
- **Claude Code** in a terminal next to it, with access to the `Monitor` tool and `Bash` (to push status back).
- **(Optional)** outbound network on first screenshot: `html2canvas` is loaded dynamically from `esm.sh` the first time the checkbox is ticked. Cached after.

## 3. Install in a target project

### 3.1 Copy the two files

```
<your_project>/
├── frontend/src/dev/UiProbe.tsx      # (from ./UiProbe.tsx)
└── scripts/ui-bridge.mjs             # (from ./ui-bridge.mjs)
```

The paths above are an example convention — adapt to your project layout. If you change the path of `UiProbe.tsx`, update the dynamic import in step 3.2.

### 3.2 Add the snippet to the front entry point

In your `main.tsx` / `main.ts` / `index.tsx`, after the main `createRoot(…).render(<App/>)`, paste:

```tsx
import { createRoot } from 'react-dom/client';

/* UiProbe: dev-only tool to select an element on the page and send a prompt
 * to Claude Code via the `scripts/ui-bridge.mjs` bridge. Mounted in dev only —
 * `vite build` strips this import entirely unless VITE_UI_PROBE=1 is set. */
if (import.meta.env.DEV || import.meta.env.VITE_UI_PROBE === '1') {
  import('@/dev/UiProbe').then(({ UiProbe }) => {
    const anchor = document.createElement('div');
    anchor.setAttribute('data-ui-probe-anchor', '');
    document.body.appendChild(anchor);
    createRoot(anchor).render(<UiProbe />);
  });
}
```

Two guarantees here: `vite build` in production without the flag loads nothing, and the UiProbe React instance mounts in a *separate* `<div>` from `<App/>` — zero interference with your providers (Router, QueryClient, …) or StrictMode.

### 3.3 Enable in dev

Three ways, depending on context:

```bash
# a. Local dev (DEV flag already set by vite dev)
npm run dev
```

```bash
# b. Dev outside Vite (Storybook, SSR, build preview): set the flag
echo 'VITE_UI_PROBE=1' >> .env.local
npm run dev
```

```dockerfile
# c. Docker preview / staging image: inject as a build arg
ARG VITE_UI_PROBE=
ENV VITE_UI_PROBE=$VITE_UI_PROBE
# then in docker-compose:
# build:
#   args:
#     VITE_UI_PROBE: "1"
```

### 3.4 Start the HTTP bridge

In a separate terminal:

```bash
node scripts/ui-bridge.mjs
# [ui-bridge] listening on 127.0.0.1:8766 (SSE + screenshot + status)
```

Override the port:

```bash
UI_BRIDGE_PORT=9000 node scripts/ui-bridge.mjs
# on the front side, set VITE_UI_BRIDGE_URL=http://127.0.0.1:9000 in .env.local
```

### 3.5 Start Claude Code and set up the Monitor

In Claude Code:

```
Monitor({
  command: "node scripts/ui-bridge.mjs",
  description: "UI probe — prompts from the SPA",
  timeout_ms: 1800000
})
```

Each `[ui-prompt] {…}` line from the script becomes a notification in the chat. Claude reads the payload, finds the source file for the received selector, edits it, and **pushes the status back** (see §4).

## 4. How Claude Code pushes the status back to the popup

Claude Code receives an event like `[ui-prompt] {eventId: "abc-123", prompt, selector, ...}`. To keep the popup informed, it POSTs JSON to `http://127.0.0.1:8766/ui-prompt/<eventId>/status`. Three to five typical statuses:

```bash
# On reception:
curl -s -X POST http://127.0.0.1:8766/ui-prompt/<eventId>/status \
  -H 'content-type: application/json' \
  -d '{"status":"in_progress","message":"analyzing the selector"}'

# During edit:
curl -s -X POST http://127.0.0.1:8766/ui-prompt/<eventId>/status \
  -H 'content-type: application/json' \
  -d '{"status":"editing","filePath":"src/components/Title.tsx","message":"3-line patch"}'

# On completion:
curl -s -X POST http://127.0.0.1:8766/ui-prompt/<eventId>/status \
  -H 'content-type: application/json' \
  -d '{"status":"done","filePath":"src/components/Title.tsx","message":"commit a1b2c3d"}'

# On error:
curl -s -X POST http://127.0.0.1:8766/ui-prompt/<eventId>/status \
  -H 'content-type: application/json' \
  -d '{"status":"error","message":"selector not found in sources"}'
```

The popup listens on `GET /ui-prompt/<eventId>/events` as SSE. On each POST, subscribers receive the current state and the popup updates live. Statuses `done` and `ok` close the loop in green, `error` in red, others (`in_progress`, `editing`, …) in gray.

To fetch the attached screenshot (if the user ticked the option):

```bash
curl -s http://127.0.0.1:8766/ui-prompt/<eventId>/screenshot > /tmp/probui.png.b64
# response is the `data:image/png;base64,...` data URL, decode it.
```

## 5. Developer usage

1. The floating button `◉ probe UI` appears at the bottom right.
2. Click the button **or** press **Alt + U** → targeting mode.
3. Each hovered element is outlined in blue.
4. Click an element → popup with the CSS selector and a textarea.
5. **(Opt-in)** check *Attach a screenshot*: on the next send, a PNG of the element is captured (via html2canvas loaded dynamically) and attached. Checkbox state is persisted in localStorage.
6. **(Nav)** arrows ↑/↓ at the top of the popup to go to the parent or first child before sending — the outline follows.
7. **(History)** *Recent prompts* dropdown with the last 10 sent prompts (localStorage), replay any with one click.
8. Type the prompt, press **Cmd/Ctrl + Enter** to send.
9. The popup shows `sending…` then `sent, Claude listening…`, then updates live on every status Claude pushes: `in_progress` / `editing · src/X.tsx` / `✓ done` / `✗ error`.
10. **Esc** at any time to leave the popup, or click *close*.

## 6. Bridge HTTP API

| Verb | Path | Role |
|---|---|---|
| `POST` | `/ui-prompt` | Create an event. Returns `201 {eventId}`. Payload accepts `prompt, selector, url, excerpt, viewport, screenshot` (optional). |
| `POST` | `/ui-prompt/<id>/status` | Push `{status, message?, filePath?}`. Fanned out to SSE subscribers. `204`. |
| `GET` | `/ui-prompt/<id>/events` | SSE: status stream for this event. First line = current state. |
| `GET` | `/ui-prompt/<id>` | Current state JSON (simple polling). |
| `GET` | `/ui-prompt/<id>/screenshot` | Returns the attached PNG as a data URL in `text/plain`. 404 if no capture. |

Limits enforced by the bridge:

| Field | Limit |
|---|---|
| `prompt` | 4000 chars |
| `selector` | 500 chars |
| `url` | 500 chars |
| `excerpt` | 2000 chars |
| `screenshot` (base64) | 3 MiB |
| HTTP body total | 4 MiB |
| Events kept in memory | 100 (FIFO) |

Format emitted on stdout (no screenshot, bool `hasScreenshot` instead):

```
[ui-prompt] {"eventId":"a7b3…","t":"2026-11-24T15:42:10.123Z","prompt":"increase the spacing","selector":"main > section.card > h2:nth-of-type(1)","url":"http://localhost:5173/day/3","excerpt":"<h2 class=\"text-xl\">Today's mission</h2>","viewport":{"w":1440,"h":900},"hasScreenshot":true}
```

## 7. Configuration and customization

### Bridge URL on the front

Set `VITE_UI_BRIDGE_URL` in a `.env.local` (or as a Docker build arg). Default: `http://127.0.0.1:8766`. The path is appended automatically; the final URL will be `<base>/ui-prompt`.

### Bridge port on the back

`UI_BRIDGE_PORT=9000 node ui-bridge.mjs`.

### Allowed CORS origins

`ui-bridge.mjs`, constant `ALLOWED_ORIGINS`: the CORS allowlist. Defaults cover common dev ports — Vite (5173/5174/5175), Vite preview (4173), CRA / Next (3000), VS Code Live Server (5500), generic container (8080), with both `localhost` and `127.0.0.1` variants. Add your dev server if it falls outside these defaults.

### Styles / colors

Everything is inline-styled in `UiProbe.tsx` to stay independent of the host theming. The main accent colors:

- `#6388e3`: brand blue (border, send button, selection outline)
- `#030d20` / `#edf2ff` / `#92b0fa`: popup background, text, mono
- `#78d978`: success (`done` status)
- `#ff4e41`: error

To match your design system: search-and-replace those hex values. The mono font is **Kode Mono**; if you don't load it, the `font-family` falls back to the system mono font.

### Built CSS selector

`buildSelector()` constructs a path "id if present, otherwise tag + nth-of-type + semantic class". The rule `/^[a-z-]+-/` skips utility classes (Tailwind, Bootstrap, …). The popup's ↑/↓ arrows let you correct if the first click landed too deep or too shallow.

### localStorage keys

- `probui.recent_prompts.v1`: list of the last 10 prompts.
- `probui.capture_enabled.v1`: state of the *Attach a screenshot* checkbox.

## 8. Security

- **Loopback by default**: the bridge listens on `127.0.0.1` unless `UI_BRIDGE_HOST=0.0.0.0` is set. In loopback mode, no auth is enforced.
- **Bearer token when exposed**: once `UI_BRIDGE_TOKEN=<secret>` is set, every endpoint rejects requests without `Authorization: Bearer <secret>` (401). Mandatory the moment the bridge leaves loopback.
- **Explicit flag in prod**: without `VITE_UI_PROBE=1`, the dynamic import is never loaded.
- **Strict CORS**: `ALLOWED_ORIGINS` is a closed allowlist. Extra origins can be appended with `UI_BRIDGE_EXTRA_ORIGINS=https://a.com,https://b.com`.
- **Size limits**: 4 MiB HTTP body, 3 MiB screenshot, 4000 char prompt, 100 events in memory max.
- **No execution**: the bridge only writes to stdout and relays statuses. Actual execution comes from Claude Code, which asks the user for permission as for any file edit.
- **Screenshot opt-in**: disabled by default, the user explicitly ticks it. `html2canvas` is loaded only on first opt-in.

**Do not ship `VITE_UI_PROBE=1` to real production** — it's a dev tool. The flag is fine on an internal staging.

## 8.1. Shared bridge for a team

The default loopback mode is for a single developer. When several teammates need to send prompts to one Claude Code session (typical case : one lead runs the bridge and the Monitor, the rest of the team uses the overlay from their own browser) :

**On the host that runs Claude Code and the bridge** :

```bash
# Generate a token once (keep it out of git)
export UI_BRIDGE_TOKEN="$(openssl rand -hex 24)"
# Start the bridge, bound on all interfaces
UI_BRIDGE_HOST=0.0.0.0 \
UI_BRIDGE_TOKEN="$UI_BRIDGE_TOKEN" \
UI_BRIDGE_EXTRA_ORIGINS="https://staging.example.com" \
  node ui-bridge.mjs
```

Put HTTPS in front of the bridge (Caddy, nginx, Traefik, cloudflared tunnel). The bridge itself only speaks plain HTTP — TLS is the reverse proxy's job.

**On each teammate's browser** :

Open the probui popup → **⚙ bridge** floating button → set :
- **bridge URL** : `https://bridge.example.com` (the public URL of your proxy)
- **token** : the secret the host generated

Both are persisted in `localStorage` (`probui.bridge_url.v1`, `probui.token.v1`), per browser. Leave the URL empty to fall back to the compile-time default (`VITE_UI_BRIDGE_URL`) — handy for solo dev on the same machine.

**On the host, Claude Code Monitor** : nothing changes. The bridge emits `[ui-prompt] {…}` on stdout the same way. The `author` field in the payload tells Claude who sent each prompt.

## 9. Known limitations

- **One bridge at a time** per port (8766 by default). Use `UI_BRIDGE_PORT` + `VITE_UI_BRIDGE_URL` to test two projects in parallel.
- **One Monitor listens at a time on stdout**: if two Claude Code sessions attach Monitors to the same bridge, the first receives `[ui-prompt]` events, the second nothing. Status POSTs are shared via SSE, though.
- **No auth**: loopback is fine on a personal dev machine, not for a dev server exposed on a LAN. If you need to share the bridge, put a reverse proxy with auth in front.
- **Volatile in-memory events**: a bridge restart wipes `EVENTS`. Max 100 kept, FIFO. No persistent replay.
- **html2canvas has blind spots**: `@font-face` without CORS, some cross-origin `background-image`, complex SVG filters. The PNG is a useful "sketch", not a pixel-perfect capture.
- **Approximate selector**: `buildSelector` does its best with `nth-of-type` + a semantic class, 8 levels deep max. Shadow DOMs aren't traversed. The ↑/↓ arrows let you fix after the fact.
- **SSE without explicit retry**: the browser retries the EventSource in the background. If the bridge restarts, prior events are lost but the connection recovers on its own.

## 10. Kit files

| File | Role |
|---|---|
| `UiProbe.tsx` | React component — overlay, targeting mode, popup, SSE, capture, memory |
| `ui-bridge.mjs` | Loopback HTTP server — stdout NDJSON + status + SSE + screenshot |
| `README.md` | This file |
| `LICENSE` | MIT license (see §11) |

No npm dependencies. Two copy-pastes + an env flag + a `Monitor({…})` + a return `curl` = kit up and running.

## 11. License

[MIT](./LICENSE). Free to use, modify, and redistribute, with or without attribution. Drop the code into your project, patch it, redistribute to your team or open source. No warranty, no liability on the authors.
