// src/tokenMonitor.js
// 代币生命周期管理
//
// 双轨价格驱动：
//   主轨：BirdEye WS 成交流 → 实时聚合 5s K 线
//   备轨：每 5s REST 轮询 → WS 静默时生成兜底 K 线

const tokenStore    = require('./tokenStore');
const birdeyeWs     = require('./birdeyeWs');
const { getTokenOverview, getOHLCV, getPrice } = require('./birdeyeRest');
const { evaluateStrategy }                     = require('./strategy');
const webhookSender = require('./webhookSender');
const config        = require('./config');

const MAX_AGE_MS = config.monitor.tokenMaxAgeMinutes * 60 * 1000;
const CANDLE_SEC = config.monitor.candleIntervalSeconds;

// ─────────────────────────────────────────────────────────────────
// 收到新代币
// ─────────────────────────────────────────────────────────────────

async function onTokenReceived({ address, symbol, network }) {
  console.log(`[Monitor] New token: ${symbol} (${address})`);

  // 加入白名单（tokenStore.addToken 有内置去重）
  tokenStore.addToken(address, symbol, network);

  // 拉取初始元数据
  await refreshMetadata(address);

  // 预热历史 closes（缩短 RSI 冷启动时间）
  await seedHistoricalCloses(address);

  // 订阅 WS 成交流（主轨）
  birdeyeWs.subscribe(address);

  // 启动 REST 兜底轮询（备轨）
  startRestFallback(address);

  // 启动年龄计时器
  startAgeTicker(address);

  console.log(`[Monitor] ${symbol} is now being monitored. Waiting for RSI cross↑${config.rsi.buyCross} to buy.`);
}

// ─────────────────────────────────────────────────────────────────
// 元数据 & RSI 预热
// ─────────────────────────────────────────────────────────────────

async function refreshMetadata(address) {
  const overview = await getTokenOverview(address);
  if (overview) {
    tokenStore.updateTokenData(address, {
      lp:          overview.lp,
      fdv:         overview.fdv,
      price:       overview.price,
      priceChange: overview.priceChange,
    });
  }
}

async function seedHistoricalCloses(address) {
  const candles = await getOHLCV(address, 50);
  const token   = tokenStore.getToken(address);
  if (!token) return;

  if (candles && candles.length > 0) {
    const closes = candles
      .map(c => c.c ?? c.close ?? null)
      .filter(v => v !== null && v > 0);

    if (closes.length > 0) {
      token.closes = closes;
      console.log(`[Monitor] Seeded ${closes.length} x 1m closes for ${token.symbol}`);
      return;
    }
  }
  console.log(`[Monitor] No history for ${token.symbol} — RSI warms up from live data`);
}

// ─────────────────────────────────────────────────────────────────
// REST 兜底轮询（备轨）
// ─────────────────────────────────────────────────────────────────

function startRestFallback(address) {
  let lastFallbackWindow = -1;

  const timer = setInterval(async () => {
    const token = tokenStore.getToken(address);
    if (!token || !token.active) {
      clearInterval(timer);
      return;
    }

    const now         = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / CANDLE_SEC) * CANDLE_SEC;

    if (token._candleWindow && token._candleWindow.windowStart === windowStart) return;
    if (lastFallbackWindow === windowStart) return;

    const price = await getPrice(address);
    if (!price || price <= 0) return;

    if (token._candleWindow && token._candleWindow.windowStart === windowStart) return;
    if (!token.active) return;

    tokenStore.updateTokenData(address, { price });

    const candle = {
      time:       windowStart,
      open:       price,
      high:       price,
      low:        price,
      close:      price,
      volume:     0,
      trades:     0,
      isFallback: true,
    };

    token.candles.push(candle);
    if (token.candles.length > 500) token.candles.shift();

    tokenStore.pushClose(address, price);
    tokenStore.emit('newCandle', { address, candle, token });

    lastFallbackWindow = windowStart;
    console.log(`[Fallback] ${token.symbol} @ $${price.toFixed(8)}`);

  }, CANDLE_SEC * 1000);
}

// ─────────────────────────────────────────────────────────────────
// 年龄计时器 & 到期退出
// ─────────────────────────────────────────────────────────────────

function startAgeTicker(address) {
  let lastMetaRefresh = Date.now();

  const interval = setInterval(async () => {
    const token = tokenStore.getToken(address);
    if (!token || !token.active) {
      clearInterval(interval);
      return;
    }

    const now   = Date.now();
    const ageMs = now - token.addedAt;
    token.age   = Math.floor(ageMs / 60000);

    // 每 30s 刷新元数据
    if (now - lastMetaRefresh >= 30000) {
      lastMetaRefresh = now;
      await refreshMetadata(address);
    }

    // ── 退出条件 1：监控时长超过 30 分钟 ────────────────────────────
    const ageExpired = ageMs >= MAX_AGE_MS;

    // ── 退出条件 2：FDV 低于最小值（默认 10000 USD）────────────────
    // FDV 过低说明市值已大幅萎缩，继续持有意义不大
    const fdvTooLow = token.fdv !== null && token.fdv < config.monitor.fdvMinimum;

    if (ageExpired || fdvTooLow) {
      const reason = ageExpired ? `AGE_EXPIRE (${token.age}m)` : `FDV_TOO_LOW (${token.fdv?.toFixed(0)})`;
      console.log(`[Monitor] Exit: ${token.symbol} — ${reason}`);
      clearInterval(interval);
      birdeyeWs.unsubscribe(address);
      tokenStore.removeToken(address); // 立即 active=false，阻断策略
      // 有持仓则发 SELL
      if (token.addPositionOpen) {
        const strategy = ageExpired ? 'AGE_EXPIRE' : 'FDV_TOO_LOW';
        await webhookSender.sendSell(address, token.symbol, strategy, token.price);
        token.addPositionOpen = false;
      }
      console.log(`[Monitor] Removed: ${token.symbol}`);
    }
  }, 1000);
}

// ─────────────────────────────────────────────────────────────────
// 新蜡烛 → 策略（传入 candle 对象供策略使用 high/low）
// ─────────────────────────────────────────────────────────────────

tokenStore.on('newCandle', async ({ address, candle, token }) => {
  if (!token.active) return;
  try {
    await evaluateStrategy(address, candle);
  } catch (err) {
    console.error(`[Monitor] Strategy error for ${token.symbol}:`, err.message);
  }
});

module.exports = { onTokenReceived, refreshMetadata };
