// src/index.js
// Entry point - starts all services

require('dotenv').config();
const config = require('./config');

// Validate required config
if (!config.birdeye.apiKey) {
  console.error('[ERROR] BIRDEYE_API_KEY is not set in .env');
  process.exit(1);
}
if (!config.helius.apiKey) {
  console.warn('[WARN] HELIUS_API_KEY is not set - Helius RPC unavailable');
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  SOL Monitor - 5s Candle Strategy System');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Webhook receiver: http://0.0.0.0:${config.server.port}/webhook/add-token`);
console.log(`  Dashboard:        http://0.0.0.0:${config.server.port}/`);
console.log(`  Trade bot BUY:    ${config.tradeBot.buyUrl}`);
console.log(`  Trade bot SELL:   ${config.tradeBot.sellUrl}`);
console.log(`  Token max age:    ${config.monitor.tokenMaxAgeMinutes} minutes`);
console.log(`  RSI period:       ${config.rsi.period}`);
console.log(`  RSI buy cross↑:   ${config.rsi.buyCross}  (add position)`);
console.log(`  RSI sell >:       ${config.rsi.sellHigh} (added position only)`);
console.log(`  RSI sell cross↓:  ${config.rsi.sellCross} (added position only)`);
console.log(`  First pos TP:     +${config.rsi.firstPositionTpPct}% price gain`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Start BirdEye WebSocket
const birdeyeWs = require('./birdeyeWs');
birdeyeWs.connect();

// Start API server (webhook receiver + dashboard API)
const { startApiServer } = require('./apiServer');
startApiServer();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[System] Shutting down gracefully...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[System] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[System] Unhandled rejection:', reason);
});
