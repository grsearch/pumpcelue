// src/birdeyeWs.js
// BirdEye WebSocket — 订阅成交流 (SUBSCRIBE_TXS)
// 每笔真实成交推送一条 trade，本地按时间窗口聚合成 5s K 线
//
// 聚合逻辑：
//   每个 token 维护一个 5 秒时间窗口（按 unixTime 向下对齐）
//   窗口内第一笔 trade → open
//   窗口内最高/最低价  → high / low
//   窗口内最后一笔     → close
//   窗口内成交额累加   → volume (USD)
//   收到属于新窗口的成交时，封口旧窗口并 emit newCandle
//
// BirdEye WS 成交消息字段（参考官方文档）:
//   type: "TXS_DATA"
//   data.address        token mint
//   data.blockUnixTime  成交时间戳（秒）
//   data.price          成交价 USD
//   data.volume         成交额 USD  (有时为 data.amount)
//   data.side           "buy" | "sell"

const WebSocket = require('ws');
const config     = require('./config');
const tokenStore = require('./tokenStore');

const CANDLE_SEC = config.monitor.candleIntervalSeconds; // 5

class BirdeyeWsManager {
  constructor() {
    this.ws             = null;
    this.connected      = false;
    this.reconnectDelay = 3000;
    this.subscriptions  = new Set();
    this.pingInterval   = null;
  }

  // ─── Public ──────────────────────────────────────────────────────

  connect() {
    console.log('[BirdEye WS] Connecting (trade stream)...');
    const url = `${config.birdeye.wsUrl}?x-api-key=${config.birdeye.apiKey}`;
    this.ws = new WebSocket(url, {
      headers: { 'x-api-key': config.birdeye.apiKey },
    });

    this.ws.on('open', () => {
      console.log('[BirdEye WS] Connected');
      this.connected = true;

      // 重连时清空所有 token 的未封口窗口，防止跨断点的脏数据混入
      for (const addr of this.subscriptions) {
        const token = tokenStore.getToken(addr);
        if (token) token._candleWindow = null;
      }

      // 重新订阅所有代币
      for (const addr of this.subscriptions) {
        this._sendSubscribe(addr);
      }

      // 保活 ping（每 20s）
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 20000);
    });

    this.ws.on('message', (data) => {
      this._handleMessage(data);
    });

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
      // close 事件随后触发，会自动重连
    });
  }

  subscribe(address) {
    this.subscriptions.add(address);
    if (this.connected) {
      this._sendSubscribe(address);
    }
  }

  unsubscribe(address) {
    this.subscriptions.delete(address);
    // 丢弃未封口窗口
    const token = tokenStore.getToken(address);
    if (token) token._candleWindow = null;

    if (this.connected && this.ws) {
      try {
        this.ws.send(JSON.stringify({
          type: 'UNSUBSCRIBE_TXS',
          data: { address },
        }));
        console.log(`[BirdEye WS] Unsubscribed: ${address}`);
      } catch (_) {}
    }
  }

  // ─── Private ─────────────────────────────────────────────────────

  _sendSubscribe(address) {
    try {
      this.ws.send(JSON.stringify({
        type: 'SUBSCRIBE_TXS',
        data: { address },
      }));
      console.log(`[BirdEye WS] Subscribed trades: ${address}`);
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

      // 成交价 / 成交额 / 时间戳 —— 兼容多种字段名
      const price  = parseFloat(d.price);
      const volume = parseFloat(d.volume ?? d.amount ?? 0);
      const ts     = parseInt(d.blockUnixTime ?? d.unixTime ?? Math.floor(Date.now() / 1000));

      if (!price || price <= 0 || !ts) return;

      // 更新最新价
      tokenStore.updateTokenData(address, { price });

      // 聚合进 5s 窗口
      this._accumulateTrade(address, price, volume, ts);

    } catch (_) {
      // 忽略解析错误，避免单条消息崩溃整个进程
    }
  }

  /**
   * 将一笔成交聚合进时间对齐的 5s K 线窗口
   */
  _accumulateTrade(address, price, volume, ts) {
    const token = tokenStore.getToken(address);
    if (!token) return;

    // 窗口起始时间向下对齐到 5s 边界
    const windowStart = Math.floor(ts / CANDLE_SEC) * CANDLE_SEC;

    // ── 首个窗口：直接初始化 ──────────────────────────────────────
    if (!token._candleWindow) {
      token._candleWindow = _newWindow(windowStart, price, volume);
      return;
    }

    const w = token._candleWindow;

    // ── 同一窗口：更新 OHLCV ─────────────────────────────────────
    if (windowStart === w.windowStart) {
      if (price > w.high) w.high = price;
      if (price < w.low)  w.low  = price;
      w.close   = price;
      w.volume += volume;
      w.trades++;
      return;
    }

    // ── 新窗口：封口旧窗口，补填空窗，开启新窗口 ─────────────────
    if (windowStart > w.windowStart) {
      // 封口并发出 K 线（至少有 1 笔成交）
      if (w.trades > 0) {
        const candle = {
          time:   w.windowStart,
          open:   w.open,
          high:   w.high,
          low:    w.low,
          close:  w.close,
          volume: w.volume,
          trades: w.trades,
        };
        token.candles.push(candle);
        if (token.candles.length > 500) token.candles.shift();

        tokenStore.pushClose(address, candle.close);
        tokenStore.emit('newCandle', { address, candle, token });

        console.log(
          `[Candle] ${token.symbol} | t=${candle.time} | ` +
          `O=${candle.open.toFixed(8)} H=${candle.high.toFixed(8)} ` +
          `L=${candle.low.toFixed(8)} C=${candle.close.toFixed(8)} | ` +
          `vol=$${candle.volume.toFixed(2)} txs=${candle.trades}`
        );
      }

      // 补填中间无成交的空窗口（用上一根收盘价填充，保持 closes 数组连续）
      let fillStart = w.windowStart + CANDLE_SEC;
      while (fillStart < windowStart) {
        token.candles.push({
          time: fillStart, open: w.close, high: w.close,
          low: w.close,    close: w.close, volume: 0, trades: 0, isFill: true,
        });
        if (token.candles.length > 500) token.candles.shift();
        tokenStore.pushClose(address, w.close);
        // 填充窗口不触发 newCandle，避免对零成交窗口跑策略
        fillStart += CANDLE_SEC;
      }

      // 开启新窗口
      token._candleWindow = _newWindow(windowStart, price, volume);
      return;
    }

    // ── 迟到成交（ts 属于已封口的旧窗口）：丢弃 ─────────────────
    // 链上确认延迟极少超过 5s，正常情况不触发
  }
}

// ─── Helper ──────────────────────────────────────────────────────

function _newWindow(windowStart, price, volume) {
  return {
    windowStart,
    open:   price,
    high:   price,
    low:    price,
    close:  price,
    volume: volume || 0,
    trades: 1,
  };
}

module.exports = new BirdeyeWsManager();
