// src/birdeyeRest.js
// BirdEye REST API calls for token metadata (LP, FDV, price)

const axios = require('axios');
const config = require('./config');

const api = axios.create({
  baseURL: config.birdeye.restUrl,
  headers: {
    'X-API-KEY': config.birdeye.apiKey,
    'x-chain': 'solana',
  },
  timeout: 10000,
});

/**
 * Get token overview: price, liquidity, FDV, etc.
 */
async function getTokenOverview(address) {
  try {
    const res = await api.get('/defi/token_overview', {
      params: { address },
    });
    const d = res.data?.data;
    if (!d) return null;
    return {
      price: d.price,
      lp: d.liquidity,
      fdv: d.fdv,
      priceChange: d.priceChange24hPercent,
      symbol: d.symbol,
      name: d.name,
    };
  } catch (e) {
    console.error('[BirdEye REST] getTokenOverview error:', e.message);
    return null;
  }
}

/**
 * Get OHLCV candles for a token (used for initial RSI seeding).
 * BirdEye minimum resolution is 1m; we fetch enough 1m bars to seed RSI(7).
 * @param {string} address
 * @param {number} limit  number of 1m bars to fetch
 */
async function getOHLCV(address, limit = 100) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - limit * 60; // 1m bars
    const res = await api.get('/defi/ohlcv', {
      params: {
        address,
        type: '1m',
        time_from: from,
        time_to: now,
      },
    });
    const items = res.data?.data?.items || [];
    return items;
  } catch (e) {
    console.error('[BirdEye REST] getOHLCV error:', e.message);
    return [];
  }
}

/**
 * Get token security info (honeypot check, etc.)
 */
async function getTokenSecurity(address) {
  try {
    const res = await api.get('/defi/token_security', {
      params: { address },
    });
    return res.data?.data || null;
  } catch (e) {
    return null;
  }
}

module.exports = { getTokenOverview, getOHLCV, getTokenSecurity };
