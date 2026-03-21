// src/config.js
require('dotenv').config();

module.exports = {
  birdeye: {
    apiKey:  process.env.BIRDEYE_API_KEY || '',
    wsUrl:   'wss://public-api.birdeye.so/socket/solana',
    restUrl: 'https://public-api.birdeye.so',
  },
  helius: {
    apiKey:  process.env.HELIUS_API_KEY || '',
    rpcUrl:  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`,
  },
  server: {
    port: parseInt(process.env.PORT) || 3003,
  },
  tradeBot: {
    buyUrl:  `http://${process.env.TRADE_BOT_HOST || 'localhost'}:${process.env.TRADE_BOT_PORT || 3002}/webhook/new-token`,
    sellUrl: `http://${process.env.TRADE_BOT_HOST || 'localhost'}:${process.env.TRADE_BOT_PORT || 3002}/force-sell`,
  },
  monitor: {
    tokenMaxAgeMinutes:    parseInt(process.env.TOKEN_MAX_AGE_MINUTES)    || 60,
    candleIntervalSeconds: parseInt(process.env.CANDLE_INTERVAL_SECONDS)  || 5,
    fdvMinimum:            parseFloat(process.env.FDV_MINIMUM)             || 10000,
  },
  rsi: {
    period:   parseInt(process.env.RSI_PERIOD)    || 7,
    buyCross: parseFloat(process.env.RSI_BUY_CROSS) || 30,
    tpPct:    parseFloat(process.env.TP_PCT)        || 150, // 止盈百分比
    slPct:    parseFloat(process.env.SL_PCT)        || 50,  // 止损百分比
  },
};
