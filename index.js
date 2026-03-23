// src/index.js
require('dotenv').config();
const config = require('./config');

if (!config.birdeye.apiKey) {
  console.error('[ERROR] BIRDEYE_API_KEY is not set in .env');
  process.exit(1);
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  SOL Monitor - EMA9/EMA20 Strategy (REST Polling)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Webhook receiver: http://0.0.0.0:${config.server.port}/webhook/add-token`);
console.log(`  Dashboard:        http://0.0.0.0:${config.server.port}/`);
console.log(`  Trade bot BUY:    ${config.tradeBot.buyUrl}`);
console.log(`  Trade bot SELL:   ${config.tradeBot.sellUrl}`);
console.log(`  Token max age:    ${config.monitor.tokenMaxAgeMinutes} minutes`);
console.log(`  REST poll:        ${process.env.REST_POLL_INTERVAL_MS || 10000}ms`);
console.log(`  FDV minimum:      $${config.monitor.fdvMinimum}`);
console.log(`  Take profit:      +${config.rsi.tpPct}%`);
console.log(`  Stop loss:        -${config.rsi.slPct}%`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const birdeyeWs = require('./birdeyeWs');
birdeyeWs.connect();

const { startApiServer } = require('./apiServer');
const { startAgeTicker } = require('./tokenMonitor');

startApiServer();
startAgeTicker();

process.on('SIGINT', () => { console.log('\n[System] Shutting down...'); process.exit(0); });
process.on('uncaughtException',   (err) => console.error('[System] Uncaught:', err));
process.on('unhandledRejection',  (r)   => console.error('[System] Rejection:', r));
