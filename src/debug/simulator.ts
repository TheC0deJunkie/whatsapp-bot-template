import type { Express, Request, Response } from 'express';
import type { BotConfig, IncomingRequest } from '../core/types.js';
import { createWebhookHandler } from '../core/engine.js';
import {
  startSimCapture,
  stopSimCapture,
} from '../adapters/twilio.js';
import { pushDebug } from './viewer.js';

/**
 * WhatsApp-like chat simulator for development.
 * Sends fake webhook requests through the full engine pipeline
 * and intercepts outbound messages to display in the chat UI.
 */
export function setupSimulatorRoutes(
  app: Express,
  config: BotConfig,
): void {
  const handler = createWebhookHandler(config);

  // Simulator UI
  app.get('/debug/simulator', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(SIMULATOR_HTML);
  });

  // Simulator API — send a message and get bot responses
  app.post('/debug/simulator', async (req: Request, res: Response) => {
    const { from, body, buttonPayload, latitude, longitude } = req.body;

    if (!from || (!body && !buttonPayload && !latitude)) {
      res.status(400).json({ error: 'Missing from or body' });
      return;
    }

    // Build a fake incoming request matching Twilio format
    const fakeReq: IncomingRequest = {
      body: {
        From: `whatsapp:${from}`,
        Body: body || '',
        ButtonPayload: buttonPayload || '',
        ...(latitude ? { Latitude: String(latitude), Longitude: String(longitude) } : {}),
      },
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
    };

    // Intercept outbound messages
    startSimCapture();

    try {
      const result = await handler(fakeReq);
      const messages = stopSimCapture();

      // Push outbound messages to debug log
      messages.forEach((m) => {
        pushDebug({
          ts: new Date().toISOString(),
          direction: 'outbound',
          from: 'bot',
          body: m.body,
        });
      });

      res.json({
        ok: true,
        status: result.status,
        messages: messages.map((m) => ({
          body: m.body,
          method: m.method,
        })),
      });
    } catch (err: any) {
      stopSimCapture();
      console.error('[simulator] error:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

// ── Simulator HTML ────────────────────────────────────────────

const SIMULATOR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bot Simulator</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b141a; display: flex; justify-content: center; padding: 20px; }
    .container { width: 100%; max-width: 420px; }
    h1 { color: #00a884; font-size: 18px; margin-bottom: 12px; text-align: center; }
    .phone-input { display: flex; gap: 8px; margin-bottom: 12px; }
    .phone-input input { flex: 1; background: #1f2c34; border: 1px solid #2a3942; color: #e9edef; padding: 8px 12px; border-radius: 8px; font-size: 14px; }
    .phone-input input::placeholder { color: #8696a0; }
    .chat { background: #0b141a; border: 1px solid #1f2c34; border-radius: 12px; height: 500px; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
    .msg { max-width: 85%; padding: 8px 12px; border-radius: 8px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
    .msg.user { background: #005c4b; color: #e9edef; align-self: flex-end; border-bottom-right-radius: 2px; }
    .msg.bot { background: #1f2c34; color: #e9edef; align-self: flex-start; border-bottom-left-radius: 2px; }
    .msg .time { font-size: 11px; color: #8696a0; text-align: right; margin-top: 4px; }
    .input-area { display: flex; gap: 8px; margin-top: 12px; }
    .input-area textarea { flex: 1; background: #1f2c34; border: 1px solid #2a3942; color: #e9edef; padding: 10px 14px; border-radius: 20px; font-size: 14px; resize: none; min-height: 42px; max-height: 120px; font-family: inherit; }
    .input-area textarea::placeholder { color: #8696a0; }
    .input-area button { background: #00a884; border: none; color: white; width: 42px; height: 42px; border-radius: 50%; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; }
    .input-area button:hover { background: #02b892; }
    .input-area button:disabled { background: #2a3942; cursor: not-allowed; }
    .quick-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .quick-actions button { background: #1f2c34; border: 1px solid #2a3942; color: #8696a0; padding: 4px 10px; border-radius: 14px; font-size: 12px; cursor: pointer; }
    .quick-actions button:hover { background: #2a3942; color: #e9edef; }
    .empty-chat { color: #8696a0; text-align: center; margin-top: 40%; font-size: 14px; }
    .typing { color: #8696a0; font-style: italic; font-size: 13px; padding: 8px 12px; }

    /* Bold/italic/strikethrough (WhatsApp markdown) */
    .msg b { font-weight: 700; }
  </style>
</head>
<body>
  <div class="container">
    <h1>WhatsApp Bot Simulator</h1>
    <div class="phone-input">
      <input type="text" id="phone" placeholder="Phone: +27821234567" value="+27821234567" />
    </div>
    <div class="chat" id="chat">
      <div class="empty-chat">Send a message to start chatting with the bot</div>
    </div>
    <div class="input-area">
      <textarea id="input" placeholder="Type a message..." rows="1"></textarea>
      <button onclick="sendMsg()" id="sendBtn">&#9658;</button>
    </div>
    <div class="quick-actions">
      <button onclick="quickSend('hi')">hi</button>
      <button onclick="quickSend('menu')">menu</button>
      <button onclick="quickSend('reset')">reset</button>
      <button onclick="quickSend('help')">help</button>
      <button onclick="quickSend('1')">1</button>
      <button onclick="quickSend('2')">2</button>
      <button onclick="quickSend('3')">3</button>
    </div>
  </div>

  <script>
    const chat = document.getElementById('chat');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('sendBtn');
    let sending = false;

    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
    });

    function timeStr() {
      return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatWa(text) {
      // WhatsApp-style markdown
      return text
        .replace(/\\*([^*]+)\\*/g, '<b>$1</b>')
        .replace(/_([^_]+)_/g, '<i>$1</i>')
        .replace(/~([^~]+)~/g, '<s>$1</s>');
    }

    function addMsg(text, type) {
      if (chat.querySelector('.empty-chat')) chat.innerHTML = '';
      const div = document.createElement('div');
      div.className = 'msg ' + type;
      div.innerHTML = formatWa(text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\\*([^*]+)\\*/g, '<b>$1</b>')
        .replace(/_([^_]+)_/g, '<i>$1</i>')) +
        '<div class="time">' + timeStr() + '</div>';
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }

    async function sendMsg() {
      const text = input.value.trim();
      if (!text || sending) return;
      sending = true;
      sendBtn.disabled = true;

      addMsg(text, 'user');
      input.value = '';
      input.style.height = 'auto';

      // Show typing indicator
      const typing = document.createElement('div');
      typing.className = 'typing';
      typing.textContent = 'Bot is typing...';
      chat.appendChild(typing);
      chat.scrollTop = chat.scrollHeight;

      try {
        const phone = document.getElementById('phone').value.trim();
        const res = await fetch('/debug/simulator', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: phone, body: text }),
        });
        const data = await res.json();
        typing.remove();

        if (data.messages && data.messages.length > 0) {
          data.messages.forEach(m => addMsg(m.body, 'bot'));
        } else {
          addMsg('(no response)', 'bot');
        }
      } catch (err) {
        typing.remove();
        addMsg('Error: ' + err.message, 'bot');
      }
      sending = false;
      sendBtn.disabled = false;
      input.focus();
    }

    function quickSend(text) {
      input.value = text;
      sendMsg();
    }

    input.focus();
  </script>
</body>
</html>`;
