// src/webhookSender.js
// Sends BUY / SELL signals to the downstream trading bot webhook

const axios = require('axios');
const config = require('./config');
const tokenStore = require('./tokenStore');

async function sendBuy(mint, symbol, strategy, price) {
  const payload = { mint, symbol };
  try {
    await axios.post(config.tradeBot.buyUrl, payload, { timeout: 5000 });
    console.log(`[Webhook] BUY sent: ${symbol} | Strategy: ${strategy} | Price: ${price}`);
  } catch (e) {
    console.error(`[Webhook] BUY FAILED: ${symbol} -`, e.message);
  }
  tokenStore.logSignal(mint, symbol, 'BUY', strategy, price);
}

async function sendSell(mint, symbol, strategy, price) {
  const payload = { mint, signal: 'SELL' };
  try {
    await axios.post(config.tradeBot.sellUrl, payload, { timeout: 5000 });
    console.log(`[Webhook] SELL sent: ${symbol} | Strategy: ${strategy} | Price: ${price}`);
  } catch (e) {
    console.error(`[Webhook] SELL FAILED: ${symbol} -`, e.message);
  }
  tokenStore.logSignal(mint, symbol, 'SELL', strategy, price);
}

module.exports = { sendBuy, sendSell };
