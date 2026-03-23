// src/tokenStore.js
const EventEmitter = require('events');

class TokenStore extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
    this.tokens    = new Map();
    this.signalLog = [];
  }

  addToken(address, symbol, network = 'solana') {
    if (this.tokens.has(address)) {
      return this.tokens.get(address);
    }
    const token = {
      // ── 基础信息 ──────────────────────────────────────────────────
      address,
      symbol,
      network,
      addedAt:      Date.now(),
      age:          0,
      active:       true,

      // ── 行情数据 ──────────────────────────────────────────────────
      lp:           null,
      fdv:          null,
      price:        null,
      priceChange:  null,
      candles:      [],
      closes:       [],

      // ── EMA（由 strategy.js 实时写入，由 tokenMonitor 广播）──────
      ema9:         null,
      ema20:        null,

      // ── 仓位状态 ──────────────────────────────────────────────────
      hasBought:       false,
      positionOpen:    false,
      isFirstPosition: false,
      entryPrice:      null,
      entryAt:         null,
      pnl:             0,
      sellCount:       0,

      // ── K 线聚合窗口（WS 内部使用，已基本弃用）──────────────────
      _candleWindow: null,
    };

    this.tokens.set(address, token);
    this.emit('tokenAdded', token);
    return token;
  }

  getToken(address)    { return this.tokens.get(address); }
  getAllTokens()        { return Array.from(this.tokens.values()); }
  getActiveTokens()    { return Array.from(this.tokens.values()).filter(t => t.active); }

  removeToken(address) {
    const token = this.tokens.get(address);
    if (token) {
      token.active = false;
      this.emit('tokenRemoved', token);
    }
  }

  updateTokenData(address, data) {
    const token = this.tokens.get(address);
    if (!token) return;
    Object.assign(token, data);
    this.emit('tokenUpdated', token);
  }

  pushClose(address, closePrice) {
    const token = this.tokens.get(address);
    if (!token || !token.active) return;
    token.closes.push(closePrice);
    if (token.closes.length > 300) token.closes.shift();
  }

  logSignal(address, symbol, type, strategy, price) {
    const entry = {
      id:        Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      address,
      symbol,
      type,
      strategy,
      price,
    };
    this.signalLog.unshift(entry);
    if (this.signalLog.length > 500) this.signalLog.pop();
    this.emit('signalLogged', entry);
    return entry;
  }

  getSignalLog(limit = 100) {
    return this.signalLog.slice(0, limit);
  }
}

module.exports = new TokenStore();
