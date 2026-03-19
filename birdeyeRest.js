// src/birdeyeRest.js
// BirdEye REST API：元数据、历史K线、实时价格

const axios  = require('axios');
const config = require('./config');

const api = axios.create({
  baseURL: config.birdeye.restUrl,
  headers: {
    'X-API-KEY': config.birdeye.apiKey,
    'x-chain':   'solana',
  },
  timeout: 8000,
});

// ─────────────────────────────────────────────────────────────────

/**
 * 获取代币概览：价格、LP、FDV 等
 */
async function getTokenOverview(address) {
  try {
    const res = await api.get('/defi/token_overview', { params: { address } });
    const d   = res.data?.data;
    if (!d) return null;
    return {
      price:       d.price,
      lp:          d.liquidity,
      fdv:         d.fdv,
      priceChange: d.priceChange24hPercent,
      symbol:      d.symbol,
      name:        d.name,
    };
  } catch (e) {
    console.error('[BirdEye REST] getTokenOverview error:', e.message);
    return null;
  }
}

/**
 * 获取单个代币最新价格（轻量接口，用于 REST 兜底轮询）
 * 使用 /defi/price 接口，比 token_overview 更轻、更快
 */
async function getPrice(address) {
  try {
    const res = await api.get('/defi/price', { params: { address } });
    const val = res.data?.data?.value;
    return val ? parseFloat(val) : null;
  } catch (e) {
    // 静默失败，兜底轮询允许偶尔失败
    return null;
  }
}

/**
 * 获取历史 OHLCV（用于 RSI 预热）
 * BirdEye REST 最小粒度 1m，取最近 limit 根
 */
async function getOHLCV(address, limit = 50) {
  try {
    const now  = Math.floor(Date.now() / 1000);
    const from = now - limit * 60;
    const res  = await api.get('/defi/ohlcv', {
      params: { address, type: '1m', time_from: from, time_to: now },
    });
    return res.data?.data?.items || [];
  } catch (e) {
    console.error('[BirdEye REST] getOHLCV error:', e.message);
    return [];
  }
}

module.exports = { getTokenOverview, getPrice, getOHLCV };
