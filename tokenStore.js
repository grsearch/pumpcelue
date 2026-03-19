// src/tokenStore.js
// In-memory whitelist & signal log for monitored tokens

const EventEmitter = require('events');

class TokenStore extends EventEmitter {
  constructor() {
    super();
    // Map<address, TokenInfo>
    this.tokens = new Map();
    // Array of signal log entries
    this.signalLog = [];
  }

  /**
   * Add a token to the whitelist
   * @param {string} address
   * @param {string} symbol
   * @param {string} network
   */
  addToken(address, symbol, network = 'solana') {
    if (this.tokens.has(address)) {
      return this.tokens.get(address);
    }
    const token = {
      address,
      symbol,
      network,
      addedAt: Date.now(),
      age: 0,              // minutes since added
      lp: null,            // liquidity pool value USD
      fdv: null,           // fully diluted valuation USD
      price: null,
      priceChange: null,
      pnl: 0,              // total PnL tracking (informational)
      candles: [],         // array of 5s candle objects
      closes: [],          // close prices for RSI calculation
      rsi: null,
      prevRsi: null,
      positionOpen: false, // whether a buy signal was sent for "first position"
      isFirstPosition: false,      // true = current open position is the first-entry position
      firstPositionEntryPrice: null, // price at which first position was entered
      additionCount: 0,    // how many add-to-position signals sent
      sellCount: 0,        // how many sell signals sent
      active: true,
    };
    this.tokens.set(address, token);
    this.emit('tokenAdded', token);
    return token;
  }

  getToken(address) {
    return this.tokens.get(address);
  }

  getAllTokens() {
    return Array.from(this.tokens.values());
  }

  getActiveTokens() {
    return Array.from(this.tokens.values()).filter(t => t.active);
  }

  removeToken(address) {
    const token = this.tokens.get(address);
    if (token) {
      token.active = false;
      this.emit('tokenRemoved', token);
    }
  }

  /**
   * Update token market data
   */
  updateTokenData(address, data) {
    const token = this.tokens.get(address);
    if (!token) return;
    Object.assign(token, data);
    this.emit('tokenUpdated', token);
  }

  /**
   * Push a new 5s candle close price
   */
  pushClose(address, closePrice) {
    const token = this.tokens.get(address);
    if (!token || !token.active) return;
    token.closes.push(closePrice);
    // Keep last 200 closes
    if (token.closes.length > 200) {
      token.closes.shift();
    }
  }

  /**
   * Log a trading signal
   */
  logSignal(address, symbol, type, strategy, price) {
    const entry = {
      id: Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      address,
      symbol,
      type,       // 'BUY' | 'SELL'
      strategy,   // e.g. 'FIRST_POSITION' | 'RSI_CROSS_33' | 'RSI_ABOVE_80' | 'RSI_CROSS_DOWN_70' | 'AGE_EXPIRE'
      price,
    };
    this.signalLog.unshift(entry);
    // Keep last 500 entries
    if (this.signalLog.length > 500) this.signalLog.pop();
    this.emit('signalLogged', entry);
    return entry;
  }

  getSignalLog(limit = 100) {
    return this.signalLog.slice(0, limit);
  }
}

module.exports = new TokenStore();
