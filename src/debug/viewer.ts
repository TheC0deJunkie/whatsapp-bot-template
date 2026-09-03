import type { Express, Request, Response } from 'express';
import type { BotConfig, DebugEntry } from '../core/types.js';

// ── Ring Buffer ───────────────────────────────────────────────

const DEBUG_LOG_MAX = 50;
const debugLog: DebugEntry[] = [];

export function pushDebug(entry: DebugEntry): void {
  debugLog.push(entry);
  if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
}

export function getDebugLog(since?: string): DebugEntry[] {
  if (!since) return [...debugLog];
  return debugLog.filter((e) => e.ts > since);
}

export function clearDebugLog(): void {
  debugLog.length = 0;
}

// ── Debug Routes ──────────────────────────────────────────────

export function setupDebugRoutes(app: Express, _config: BotConfig): void {
  // JSON API
  app.get('/debug/log', (_req: Request, res: Response) => {
    const since = _req.query.since as string | undefined;
    const entries = since ? getDebugLog(since) : getDebugLog();
    if (_req.query.clear === '1') clearDebugLog();
    res.json({ entries, count: entries.length });
  });

  // HTML Viewer
  app.get('/debug/viewer', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(VIEWER_HTML);
  });
}

// ── Viewer HTML ───────────────────────────────────────────────

const VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bot Debug Viewer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 20px; }
    h1 { color: #58a6ff; margin-bottom: 16px; font-size: 20px; }
    .controls { display: flex; gap: 12px; margin-bottom: 16px; }
    .controls button { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .controls button:hover { background: #30363d; }
    .controls .live { color: #3fb950; }
    .controls .paused { color: #f85149; }
    #log { display: flex; flex-direction: column; gap: 8px; }
    .entry { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px; font-size: 13px; }
    .entry .meta { color: #8b949e; margin-bottom: 4px; display: flex; gap: 12px; flex-wrap: wrap; }
    .entry .meta span { display: inline-block; }
    .entry .dir-in { color: #58a6ff; }
    .entry .dir-out { color: #d2a8ff; }
    .entry .body { white-space: pre-wrap; word-break: break-word; margin-top: 6px; }
    .entry .action { color: #3fb950; font-weight: 600; }
    .entry .status { color: #f0883e; }
    .empty { color: #484f58; font-style: italic; padding: 40px; text-align: center; }
  </style>
</head>
<body>
  <h1>Bot Debug Viewer</h1>
  <div class="controls">
    <button onclick="togglePoll()" id="pollBtn" class="live">Live</button>
    <button onclick="clearLog()">Clear</button>
    <span style="color:#484f58;line-height:32px;" id="countLabel">0 entries</span>
  </div>
  <div id="log"><div class="empty">No messages yet. Send a message to see it here.</div></div>

  <script>
    let polling = true;
    let lastTs = '';

    async function fetchLog() {
      try {
        const url = lastTs ? '/debug/log?since=' + encodeURIComponent(lastTs) : '/debug/log';
        const res = await fetch(url);
        const data = await res.json();
        if (data.entries.length > 0) {
          const log = document.getElementById('log');
          if (log.querySelector('.empty')) log.innerHTML = '';
          data.entries.forEach(e => {
            const div = document.createElement('div');
            div.className = 'entry';
            const dirClass = e.direction === 'inbound' ? 'dir-in' : 'dir-out';
            const dirLabel = e.direction === 'inbound' ? 'IN' : 'OUT';
            div.innerHTML =
              '<div class="meta">' +
                '<span class="' + dirClass + '">' + dirLabel + '</span>' +
                '<span>' + e.ts.slice(11, 19) + '</span>' +
                '<span>' + (e.from || '') + '</span>' +
                (e.resolvedAction ? '<span class="action">action: ' + e.resolvedAction + '</span>' : '') +
                (e.status ? '<span class="status">status: ' + e.status + '</span>' : '') +
              '</div>' +
              '<div class="body">' + escHtml(e.body || '') + '</div>';
            log.prepend(div);
            lastTs = e.ts;
          });
          document.getElementById('countLabel').textContent = log.children.length + ' entries';
        }
      } catch (err) { console.error('poll error', err); }
    }

    function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    function togglePoll() {
      polling = !polling;
      const btn = document.getElementById('pollBtn');
      btn.textContent = polling ? 'Live' : 'Paused';
      btn.className = polling ? 'live' : 'paused';
    }

    async function clearLog() {
      await fetch('/debug/log?clear=1');
      document.getElementById('log').innerHTML = '<div class="empty">Cleared.</div>';
      document.getElementById('countLabel').textContent = '0 entries';
      lastTs = '';
    }

    setInterval(() => { if (polling) fetchLog(); }, 1500);
    fetchLog();
  </script>
</body>
</html>`;
