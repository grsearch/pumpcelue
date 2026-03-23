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
 * 获取单个代币最新价格（轻量接口）
 */
async function getPrice(address) {
  try {
    const res = await api.get('/defi/price', { params: { address } });
    const val = res.data?.data?.value;
    return val ? parseFloat(val) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 获取历史 OHLCV（预留，可用于更长周期预热）
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

/**
 * 拉取最新 N 根 1m K 线，用于 REST 轮询驱动策略
 * limit 建议 30（覆盖 EMA20 所需 + 滚动余量）
 */
async function getRecentCandles(address, limit = 30) {
  try {
    const now  = Math.floor(Date.now() / 1000);
    const from = now - limit * 60;
    const res  = await api.get('/defi/ohlcv', {
      params: { address, type: '1m', time_from: from, time_to: now },
    });
    return res.data?.data?.items || [];
  } catch (e) {
    console.error('[BirdEye REST] getRecentCandles error:', e.message);
    return [];
  }
}

module.exports = { getTokenOverview, getPrice, getOHLCV, getRecentCandles };
