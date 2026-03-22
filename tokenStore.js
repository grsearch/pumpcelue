// src/tokenStore.js
const EventEmitter = require('events');

class TokenStore extends EventEmitter {
  constructor() {
    super();
    this.tokens    = new Map();
    this.signalLog = [];
  }

  addToken(address, symbol, network = 'solana') {
    if (this.tokens.has(address)) {
      return this.tokens.get(address);
    }
    const token = {
      address,
      symbol,
      network,
      addedAt:      Date.now(),
      age:          0,
      lp:           null,
      fdv:          null,
      price:        null,
      priceChange:  null,
      pnl:          0,
      candles:      [],
      closes:       [],
      rsi:          null,
      prevRsi:      null,
      // 仓位状态（仅追踪 RSI 上穿30买入的仓位）
      positionOpen:    false,     // 首仓是否持有
      firstPosSold:    false,     // 首仓是否已止盈出场
      isFirstPosition: false,     // true=首仓
      entryPrice:      null,      // 首仓入场价
      addPositionOpen: false,
      addEntryPrice:   null,
      additionCount:   0,
      sellCount:       0,
      active:       true,

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
    if (token.closes.length > 200) token.closes.shift();
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
