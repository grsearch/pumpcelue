// src/tokenMonitor.js
// 代币生命周期管理
//
// 策略驱动：REST 轮询（每 REST_POLL_INTERVAL_MS 拉一次 1m OHLCV）
//   - 每次拉最近 30 根 1m K 线，用收盘价序列计算 EMA9/EMA20
//   - 不依赖 WS 成交推送，低活跃代币也能正常触发死叉卖出
//   - WS 保留，仅用于实时价格更新 + 止盈检查
//
// Dashboard 更新：所有状态变化均通过 tokenStore.updateTokenData 广播，
//   触发 Socket.IO tokenUpdated 事件，前端实时刷新

const config        = require('./config');
const tokenStore    = require('./tokenStore');
const birdeyeRest   = require('./birdeyeRest');
const birdeyeWs     = require('./birdeyeWs');
const webhookSender = require('./webhookSender');
const { evaluateStrategy } = require('./strategy');

const POLL_INTERVAL_MS = parseInt(process.env.REST_POLL_INTERVAL_MS) || 10000;

// 每个 address 的轮询定时器
const _pollTimers     = new Map();
// 每个 address 上次处理过的最新 K 线时间戳（去重，防止同一根 K 线重复触发策略）
const _lastCandleTime = new Map();

// ── 年龄计时器 ────────────────────────────────────────────────────
function startAgeTicker() {
  _cleanLegacyFields();

  setInterval(async () => {
    const now    = Date.now();
    const maxAge = config.monitor.tokenMaxAgeMinutes * 60 * 1000;

    for (const token of tokenStore.getActiveTokens()) {
      const age = Math.floor((now - token.addedAt) / 60000);
      tokenStore.updateTokenData(token.address, { age });

      if (now - token.addedAt >= maxAge) {
        console.log(`[Monitor] AGE_EXPIRE: ${token.symbol} (${age}m)`);
        _stopPoll(token.address);
        birdeyeWs.unsubscribe(token.address);
        tokenStore.removeToken(token.address);

        if (token.positionOpen) {
          await webhookSender.sendSell(
            token.address, token.symbol, 'AGE_EXPIRE', token.price
          );
          token.positionOpen    = false;
          token.isFirstPosition = false;
          token.entryPrice      = null;
          token.pnl             = 0;
        }
      }
    }
  }, 60 * 1000);
}

// ── REST 轮询：拉 K 线 → 驱动策略 → 广播 Dashboard ────────────────
function startRestPoll(address) {
  _stopPoll(address);

  const timer = setInterval(async () => {
    const token = tokenStore.getToken(address);
    if (!token || !token.active) { _stopPoll(address); return; }

    // 拉最近 30 根 1m K 线
    const candles = await birdeyeRest.getRecentCandles(address, 30);
    if (!candles || candles.length === 0) {
      console.log(`[Poll] ${token.symbol}: no candles returned`);
      return;
    }

    candles.sort((a, b) => a.unixTime - b.unixTime);
    const latest     = candles[candles.length - 1];
    const latestTime = latest.unixTime;

    // 去重：同一根 K 线不重复触发策略
    if (_lastCandleTime.get(address) === latestTime) return;
    _lastCandleTime.set(address, latestTime);

    const latestPrice = parseFloat(latest.c ?? latest.close ?? 0);
    const newCloses   = candles.map(c => parseFloat(c.c ?? c.close ?? 0)).filter(v => v > 0);
    const candleObjs  = candles.map(c => ({
      time:   c.unixTime,
      open:   parseFloat(c.o ?? c.open   ?? 0),
      high:   parseFloat(c.h ?? c.high   ?? 0),
      low:    parseFloat(c.l ?? c.low    ?? 0),
      close:  parseFloat(c.c ?? c.close  ?? 0),
      volume: parseFloat(c.v ?? c.volume ?? 0),
    }));

    // 直接写内部字段（closes/candles 体积大，不走 updateTokenData 避免广播噪音）
    token.closes  = newCloses;
    token.candles = candleObjs.slice(-60);

    // 计算最新 PnL
    let pnl = token.pnl || 0;
    if (token.positionOpen && token.entryPrice && latestPrice > 0) {
      pnl = parseFloat(
        ((latestPrice - token.entryPrice) / token.entryPrice * 100).toFixed(2)
      );
    }

    // ★ updateTokenData 触发 Socket.IO → Dashboard 刷新价格/PnL
    if (latestPrice > 0) {
      tokenStore.updateTokenData(address, { price: latestPrice, pnl });
    }

    console.log(
      `[Poll] ${token.symbol}: closes=${newCloses.length} latest=$${latestPrice.toFixed(8)}`
    );

    // 策略执行（evaluateStrategy 内部写 token.ema9 / token.ema20）
    if (token.positionOpen) {
      await evaluateStrategy(address, candleObjs[candleObjs.length - 1]);

      // ★ 策略执行后广播最新 EMA，Dashboard 显示
      tokenStore.updateTokenData(address, {
        ema9:  token.ema9  ?? null,
        ema20: token.ema20 ?? null,
      });
    }

    // REST 止盈检查（WS 断线时兜底）
    if (token.positionOpen && token.entryPrice && latestPrice > 0) {
      const tpPrice = token.entryPrice * (1 + config.rsi.tpPct / 100);
      if (latestPrice >= tpPrice) {
        console.log(`[Poll-TP] SELL TP +${config.rsi.tpPct}%: ${token.symbol}`);
        await webhookSender.sendSell(
          address, token.symbol, `TP_+${config.rsi.tpPct}%`, latestPrice
        );
        // ★ 止盈后广播仓位清空
        tokenStore.updateTokenData(address, {
          positionOpen:    false,
          isFirstPosition: false,
          entryPrice:      null,
          pnl:             0,
          ema9:            null,
          ema20:           null,
        });
        token.sellCount++;
      }
    }

  }, POLL_INTERVAL_MS);

  _pollTimers.set(address, timer);
  console.log(`[Poll] Started for ${address} every ${POLL_INTERVAL_MS}ms`);
}

function _stopPoll(address) {
  const timer = _pollTimers.get(address);
  if (timer) {
    clearInterval(timer);
    _pollTimers.delete(address);
    _lastCandleTime.delete(address);
    console.log(`[Poll] Stopped for ${address}`);
  }
}

// ── 新代币入列 ────────────────────────────────────────────────────
async function onTokenReceived({ address, symbol, network }) {
  console.log(`[Monitor] New token: ${symbol} (${address})`);
  _stopPoll(address);

  // 拉元数据
  const overview = await birdeyeRest.getTokenOverview(address);
  if (overview) {
    tokenStore.updateTokenData(address, {
      price:       overview.price,
      lp:          overview.lp,
      fdv:         overview.fdv,
      priceChange: overview.priceChange,
    });

    if (overview.fdv && overview.fdv < config.monitor.fdvMinimum) {
      console.log(`[Monitor] SKIP low FDV $${overview.fdv}: ${symbol}`);
      tokenStore.removeToken(address);
      return;
    }
  }

  const token = tokenStore.getToken(address);
  if (!token || !token.active) return;

  // 预热：拉 30 根历史 K 线，EMA 入列即可用
  const warmup = await birdeyeRest.getRecentCandles(address, 30);
  if (warmup && warmup.length > 0) {
    warmup.sort((a, b) => a.unixTime - b.unixTime);
    token.closes  = warmup.map(c => parseFloat(c.c ?? c.close ?? 0)).filter(v => v > 0);
    token.candles = warmup.map(c => ({
      time:   c.unixTime,
      open:   parseFloat(c.o  ?? c.open   ?? 0),
      high:   parseFloat(c.h  ?? c.high   ?? 0),
      low:    parseFloat(c.l  ?? c.low    ?? 0),
      close:  parseFloat(c.c  ?? c.close  ?? 0),
      volume: parseFloat(c.v  ?? c.volume ?? 0),
    })).slice(-60);
    _lastCandleTime.set(address, warmup[warmup.length - 1].unixTime);
    console.log(`[Monitor] Warmup: ${token.closes.length} closes for ${symbol}`);
  } else {
    console.log(`[Monitor] Warmup: no candles for ${symbol}`);
  }

  // 防重复买入
  if (token.hasBought) {
    console.log(`[Monitor] SKIP already bought: ${symbol}`);
    return;
  }

  const entryPrice = token.price;
  await webhookSender.sendBuy(address, symbol, 'FIRST_POSITION', entryPrice);

  // ★ updateTokenData 触发仓位广播，Dashboard 立刻显示持仓状态
  tokenStore.updateTokenData(address, {
    hasBought:       true,
    positionOpen:    true,
    isFirstPosition: true,
    entryPrice:      entryPrice,
    entryAt:         Date.now(),
  });
  console.log(`[Monitor] FIRST_POSITION entry=$${entryPrice} ${symbol}`);

  // 启动 REST 轮询（驱动策略）
  startRestPoll(address);

  // WS 仅用于实时价格推送 + 止盈检查
  birdeyeWs.subscribe(address);
}

// ── 清理旧版遗留字段 ──────────────────────────────────────────────
function _cleanLegacyFields() {
  let cleaned = 0;
  for (const token of tokenStore.getAllTokens()) {
    const legacy = ['rsi', 'prevRsi', 'addPositionOpen', 'addEntryPrice',
                    'additionCount', 'firstPosSold', 'firstPosStopLoss'];
    let dirty = false;
    for (const f of legacy) {
      if (f in token) { delete token[f]; dirty = true; }
    }
    if (dirty) cleaned++;
  }
  if (cleaned > 0) console.log(`[Monitor] Cleaned legacy fields from ${cleaned} tokens`);
}

module.exports = {
  onTokenReceived,
  startAgeTicker,
  _removeCandleHandlerExternal: _stopPoll, // apiServer.js remove-token 兼容
};
