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
    tokenMaxAgeMinutes:    parseInt(process.env.TOKEN_MAX_AGE_MINUTES)    || 30,
    candleIntervalSeconds: parseInt(process.env.CANDLE_INTERVAL_SECONDS)  || 5,
  },
  rsi: {
    period:             parseInt(process.env.RSI_PERIOD)            || 7,
    buyCross:           parseFloat(process.env.RSI_BUY_CROSS)       || 30,
    sellHigh:           parseFloat(process.env.RSI_SELL_HIGH)       || 80,
    sellCross:          parseFloat(process.env.RSI_SELL_CROSS)      || 70,
    firstPositionTpPct: parseFloat(process.env.FIRST_POSITION_TP_PCT) || 50,
  },
};
