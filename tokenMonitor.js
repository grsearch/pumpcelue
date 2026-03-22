// src/apiServer.js
const express  = require('express');
const cors     = require('cors');
const { createServer }     = require('http');
const { Server: SocketIO } = require('socket.io');
const config        = require('./config');
const tokenStore    = require('./tokenStore');
const { onTokenReceived } = require('./tokenMonitor');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const httpServer = createServer(app);
const io = new SocketIO(httpServer, { cors: { origin: '*' } });

// ── POST /webhook/add-token ───────────────────────────────────────
app.post('/webhook/add-token', async (req, res) => {
  const { address, symbol, network = 'solana' } = req.body;

  if (!address || !symbol) {
    return res.status(400).json({ success: false, error: 'address and symbol are required' });
  }

  const existing = tokenStore.getToken(address);
  if (existing && existing.active) {
    return res.json({ success: true, message: 'Already in whitelist', token: _safeToken(existing) });
  }

  try {
    // 先占位防重复，再异步处理
    tokenStore.addToken(address, symbol, network);
    res.status(202).json({ success: true, message: 'Token queued for monitoring', address, symbol });
    await onTokenReceived({ address, symbol, network });
  } catch (e) {
    console.error('[API] onTokenReceived error:', e.message);
  }
});

// ── GET /api/tokens ───────────────────────────────────────────────
app.get('/api/tokens', (req, res) => {
  res.json({ success: true, data: tokenStore.getAllTokens().map(_safeToken) });
});

// ── GET /api/signals ──────────────────────────────────────────────
app.get('/api/signals', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json({ success: true, data: tokenStore.getSignalLog(limit) });
});

// ── GET /api/status ───────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const ws = require('./birdeyeWs');
  res.json({
    success: true,
    data: {
      activeTokens: tokenStore.getActiveTokens().length,
      totalTokens:  tokenStore.getAllTokens().length,
      totalSignals: tokenStore.signalLog.length,
      wsConnected:  ws.connected,
      uptime:       Math.floor(process.uptime()),
    },
  });
});

// ── POST /api/remove-token ────────────────────────────────────────
app.post('/api/remove-token', async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ success: false, error: 'address required' });

  const token = tokenStore.getToken(address);
  if (!token) return res.status(404).json({ success: false, error: 'Token not found' });

  const ws            = require('./birdeyeWs');
  const webhookSender = require('./webhookSender');

  // 先停止再发信号，防止 await 期间 restFallback 触发买入
  ws.unsubscribe(address);
  tokenStore.removeToken(address);

  if (token.positionOpen || token.addPositionOpen) {
    await webhookSender.sendSell(address, token.symbol, 'MANUAL_REMOVE', token.price);
    token.positionOpen    = false;
    token.isFirstPosition = false;
    token.entryPrice      = null;
    token.addPositionOpen = false;
    token.addEntryPrice   = null;
  }

  res.json({ success: true, message: `${token.symbol} removed` });
});

// ── Socket.IO ─────────────────────────────────────────────────────
tokenStore.on('tokenAdded',   (token) => io.emit('tokenAdded', _safeToken(token)));
tokenStore.on('tokenUpdated', (token) => io.emit('tokenUpdated', {
  address:         token.address,
  symbol:          token.symbol,
  price:           token.price,
  lp:              token.lp,
  fdv:             token.fdv,
  rsi:             token.rsi !== null ? parseFloat(token.rsi.toFixed(2)) : null,
  age:             token.age,
  pnl:             token.pnl,
  positionOpen:    token.positionOpen,
  isFirstPosition: token.isFirstPosition,
  entryPrice:      token.entryPrice,
  addPositionOpen: token.addPositionOpen,
  addEntryPrice:   token.addEntryPrice,
  active:          token.active,
}));
tokenStore.on('tokenRemoved', (token) => io.emit('tokenRemoved', { address: token.address }));
tokenStore.on('signalLogged', (entry) => io.emit('signalLogged', entry));
tokenStore.on('newCandle',    ({ address, candle }) => io.emit('newCandle', { address, candle }));

// ── Helper ────────────────────────────────────────────────────────
function _safeToken(t) {
  return {
    address:         t.address,
    symbol:          t.symbol,
    age:             t.age,
    lp:              t.lp,
    fdv:             t.fdv,
    price:           t.price,
    priceChange:     t.priceChange,
    pnl:             t.pnl,
    rsi:             t.rsi !== null && t.rsi !== undefined ? parseFloat(t.rsi.toFixed(2)) : null,
    positionOpen:    t.positionOpen,
    isFirstPosition: t.isFirstPosition,
    entryPrice:      t.entryPrice,
    addPositionOpen: t.addPositionOpen,
    addEntryPrice:   t.addEntryPrice,
      additionCount:   t.additionCount,
    sellCount:       t.sellCount,
    active:          t.active,
    addedAt:         t.addedAt,
    candles:         t.candles.slice(-60),
  };
}

function startApiServer() {
  httpServer.listen(config.server.port, '0.0.0.0', () => {
    console.log(`[API] Listening on port ${config.server.port}`);
  });
}

module.exports = { startApiServer, io };
