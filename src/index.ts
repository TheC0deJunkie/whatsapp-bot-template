import express from 'express';
import { createWebhookHandler } from './core/engine.js';
import { botConfig } from './bot.js';
import { setupDebugRoutes } from './debug/viewer.js';
import { setupSimulatorRoutes } from './debug/simulator.js';

const app = express();

// ── Middleware ───────────────────────────────────────────────
// Twilio sends URL-encoded bodies
app.use(express.urlencoded({ extended: false }));
// Simulator sends JSON
app.use(express.json());

// ── Webhook Endpoint ────────────────────────────────────────
const handleWebhook = createWebhookHandler(botConfig);

app.post('/webhook', async (req, res) => {
  try {
    const result = await handleWebhook({
      body: req.body,
      headers: req.headers as Record<string, string | string[] | undefined>,
      url: req.url,
      originalUrl: req.originalUrl,
      protocol: req.protocol,
    });
    res.status(result.status).send(result.body ?? '');
  } catch (err) {
    console.error('[webhook] unhandled error:', err);
    res.status(500).send('Internal error');
  }
});

// ── Health Check ────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ── Debug Routes (non-production only) ──────────────────────
if (botConfig.debug) {
  setupDebugRoutes(app, botConfig);
  setupSimulatorRoutes(app, botConfig);
  console.log(`Debug viewer:    http://localhost:${process.env.PORT || 3000}/debug/viewer`);
  console.log(`Simulator:       http://localhost:${process.env.PORT || 3000}/debug/simulator`);
}

// ── Start Server (standalone mode) ──────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot server listening on http://localhost:${PORT}`);
  console.log(`Webhook URL:     http://localhost:${PORT}/webhook`);
});

// ── Vercel Export ───────────────────────────────────────────
export default app;
