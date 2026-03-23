// src/birdeyeWs.js
// BirdEye WebSocket — 仅用于实时价格更新 + 止盈检查
// 策略驱动已改为 REST 轮询（tokenMonitor.js），WS 不再聚合 K 线

const WebSocket  = require('ws');
const config     = require('./config');
const tokenStore = require('./tokenStore');

class BirdeyeWsManager {
  constructor() {
    this.ws             = null;
    this.connected      = false;
    this.reconnectDelay = 3000;
    this.subscriptions  = new Set();
    this.pingInterval   = null;
  }

  connect() {
    console.log('[BirdEye WS] Connecting...');
    const url = `${config.birdeye.wsUrl}?x-api-key=${config.birdeye.apiKey}`;
    this.ws = new WebSocket(url, {
      headers: { 'x-api-key': config.birdeye.apiKey },
    });

    this.ws.on('open', () => {
      console.log('[BirdEye WS] Connected');
      this.connected = true;

      for (const addr of this.subscriptions) {
        this._sendSubscribe(addr);
      }

      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 20000);
    });

    this.ws.on('message', (data) => this._handleMessage(data));

    this.ws.on('close', () => {
      console.log('[BirdEye WS] Disconnected, reconnecting in 3s...');
      this.connected = false;
      clearInterval(this.pingInterval);
      this.pingInterval = null;
      this.ws.removeAllListeners();
      this.ws = null;
      setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.ws.on('error', (err) => {
      console.error('[BirdEye WS] Error:', err.message);
    });
  }

  subscribe(address) {
    this.subscriptions.add(address);
    if (this.connected) this._sendSubscribe(address);
  }

  unsubscribe(address) {
    this.subscriptions.delete(address);

    if (this.connected && this.ws) {
      try {
        this.ws.send(JSON.stringify({
          type: 'UNSUBSCRIBE_TXS',
          data: { queryType: 'simple', address },
        }));
        console.log(`[BirdEye WS] Unsubscribed: ${address}`);
      } catch (_) {}
    }
  }

  _sendSubscribe(address) {
    try {
      this.ws.send(JSON.stringify({
        type: 'SUBSCRIBE_TXS',
        data: { queryType: 'simple', address },
      }));
      console.log(`[BirdEye WS] Subscribed: ${address}`);
    } catch (e) {
      console.error('[BirdEye WS] Subscribe error:', e.message);
    }
  }

  _handleMessage(raw) {
    try {
      const msg = JSON.parse(raw);
      if (msg.type !== 'TXS_DATA' || !msg.data) return;

      const d       = msg.data;
      const address = d.address;
      if (!address) return;

      const token = tokenStore.getToken(address);
      if (!token || !token.active) return;

      const price = parseFloat(d.price);
      if (!price || price <= 0) return;

      // 更新最新价格（触发 Dashboard 实时刷新）
      tokenStore.updateTokenData(address, { price });

      // 更新浮盈
      if (token.positionOpen && token.entryPrice) {
        const pnl = parseFloat(
          ((price - token.entryPrice) / token.entryPrice * 100).toFixed(2)
        );
        token.pnl = pnl;
      }

      // 实时止盈检查（每笔成交触发，防止 REST 轮询间隔内错过止盈点）
      this._checkTakeProfit(address, price);

    } catch (_) {}
  }

  _checkTakeProfit(address, price) {
    const token = tokenStore.getToken(address);
    if (!token || !token.active)  return;
    if (!token.positionOpen)      return;
    if (!token.entryPrice)        return;

    const tpPrice = token.entryPrice * (1 + config.rsi.tpPct / 100);

    if (price >= tpPrice) {
      const webhookSender = require('./webhookSender');
      console.log(
        `[WS-TP] SELL TP +${config.rsi.tpPct}%: ${token.symbol} ` +
        `price=$${price.toFixed(8)} entry=$${token.entryPrice.toFixed(8)}`
      );
      webhookSender.sendSell(
        address, token.symbol, `TP_+${config.rsi.tpPct}%`, tpPrice
      ).then(() => {
        tokenStore.updateTokenData(address, {
          positionOpen:    false,
          isFirstPosition: false,
          entryPrice:      null,
          pnl:             0,
          ema9:            null,
          ema20:           null,
        });
        token.sellCount++;
      });
    }
  }
}

module.exports = new BirdeyeWsManager();
