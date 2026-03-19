// src/tokenMonitor.js
// 代币生命周期管理：加入白名单、元数据刷新、年龄追踪、到期退出
//
// 双轨价格驱动：
//   主轨：BirdEye WS 成交流 → 实时聚合 5s K 线（有成交时最精确）
//   备轨：每 5s REST 轮询最新价格 → 若 WS 静默则强制生成 5s K 线
//         保证低流动性新币或 WS 推送延迟时策略仍能正常运行

const tokenStore    = require('./tokenStore');
const birdeyeWs     = require('./birdeyeWs');
const { getTokenOverview, getOHLCV, getPrice } = require('./birdeyeRest');
const { evaluateStrategy }                     = require('./strategy');
const webhookSender = require('./webhookSender');
const config        = require('./config');

const MAX_AGE_MS   = config.monitor.tokenMaxAgeMinutes * 60 * 1000;
const CANDLE_SEC   = config.monitor.candleIntervalSeconds; // 5

// ─────────────────────────────────────────────────────────────────
// 公共入口
// ─────────────────────────────────────────────────────────────────

/**
 * 收到扫描服务器 webhook 时调用
 */
async function onTokenReceived({ address, symbol, network }) {
  console.log(`[Monitor] New token: ${symbol} (${address})`);

  // 加入内存白名单
  const token = tokenStore.addToken(address, symbol, network);

  // 1) 立即发送首仓 BUY 信号
  await webhookSender.sendBuy(address, symbol, 'FIRST_POSITION', null);
  token.positionOpen    = true;
  token.isFirstPosition = true;  // 首仓：仅止盈卖出，RSI 卖出不生效
  token.entryPrice      = null;  // 拉取元数据后填入
  token.additionCount   = 0;

  // 2) 拉取初始元数据，将当前价格记为首仓入场价
  await refreshMetadata(address);
  const tok = tokenStore.getToken(address);
  if (tok && tok.price) {
    tok.entryPrice = tok.price;
    console.log(`[Monitor] Entry price: $${tok.price} for ${symbol}`);
  }

  // 3) 用历史 1m K 线预热 RSI（新币可能无数据，属正常）
  await seedHistoricalCloses(address);

  // 4) 订阅 WS 成交流（主轨）
  birdeyeWs.subscribe(address);

  // 5) 启动 REST 兜底轮询（备轨）
  startRestFallback(address);

  // 6) 启动年龄计时器
  startAgeTicker(address);
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
      console.log(
        `[Monitor] Seeded ${closes.length} x 1m closes for ${token.symbol} ` +
        `(RSI needs ${config.rsi.period + 2} min)`
      );
      return;
    }
  }
  console.log(`[Monitor] No history for ${token.symbol} — RSI warms up from live data`);
}

// ─────────────────────────────────────────────────────────────────
// REST 兜底轮询（备轨）
//
// 每 CANDLE_SEC 秒轮询一次最新价格。
// 若 WS 成交流正常工作，_candleWindow 会随成交不断更新，
// 兜底逻辑检测到"当前窗口已被 WS 处理"则跳过，不重复生成蜡烛。
// 若 WS 静默（无成交推送），兜底定时器在窗口到期时用 REST 价格封口，
// 强制产生一根蜡烛，触发策略计算。
// ─────────────────────────────────────────────────────────────────

function startRestFallback(address) {
  // 记录上一次兜底封口的窗口起始时间，防止重复封口同一窗口
  let lastFallbackWindow = -1;

  const timer = setInterval(async () => {
    const token = tokenStore.getToken(address);
    if (!token || !token.active) {
      clearInterval(timer);
      return;
    }

    const now         = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / CANDLE_SEC) * CANDLE_SEC;

    // 若 WS 已在当前窗口产生了成交，跳过（WS 主轨优先）
    if (token._candleWindow && token._candleWindow.windowStart === windowStart) {
      return;
    }

    // 若本轮已经兜底过这个窗口，跳过
    if (lastFallbackWindow === windowStart) return;

    // 拉取最新价格
    const price = await getPrice(address);
    if (!price || price <= 0) return;

    // 再次检查（await 期间 WS 可能已处理）
    if (token._candleWindow && token._candleWindow.windowStart === windowStart) return;
    if (!token.active) return;

    // 更新价格
    tokenStore.updateTokenData(address, { price });

    // 生成兜底蜡烛（open=high=low=close=price，volume=0）
    const candle = {
      time:     windowStart,
      open:     price,
      high:     price,
      low:      price,
      close:    price,
      volume:   0,
      trades:   0,
      isFallback: true, // 标记为 REST 兜底，非真实成交
    };

    token.candles.push(candle);
    if (token.candles.length > 500) token.candles.shift();

    tokenStore.pushClose(address, price);
    tokenStore.emit('newCandle', { address, candle, token });

    lastFallbackWindow = windowStart;
    console.log(`[Fallback] ${token.symbol} REST candle @ $${price.toFixed(8)} (no WS trade in window)`);

  }, CANDLE_SEC * 1000); // 每 5 秒执行一次
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

    // 每 30s 刷新一次元数据
    if (now - lastMetaRefresh >= 30000) {
      lastMetaRefresh = now;
      await refreshMetadata(address);
    }

    // 到期处理
    if (ageMs >= MAX_AGE_MS) {
      console.log(`[Monitor] Expired: ${token.symbol} (${token.age}m)`);
      clearInterval(interval);
      // 首仓未平：发 SELL
      if (token.positionOpen) {
        await webhookSender.sendSell(address, token.symbol, 'AGE_EXPIRE', token.price);
        token.positionOpen = false;
      }
      // 加仓未平：发 SELL（与首仓独立，可能都开着）
      if (token.addPositionOpen) {
        await webhookSender.sendSell(address, token.symbol, 'AGE_EXPIRE', token.price);
        token.addPositionOpen = false;
      }
      birdeyeWs.unsubscribe(address);
      tokenStore.removeToken(address);
      console.log(`[Monitor] Removed: ${token.symbol}`);
    }
  }, 1000);
}

// ─────────────────────────────────────────────────────────────────
// 新蜡烛事件 → 策略
// ─────────────────────────────────────────────────────────────────

tokenStore.on('newCandle', async ({ address, candle, token }) => {
  if (!token.active) return;
  try {
    await evaluateStrategy(address);
  } catch (err) {
    console.error(`[Monitor] Strategy error for ${token.symbol}:`, err.message);
  }
});

module.exports = { onTokenReceived, refreshMetadata };
