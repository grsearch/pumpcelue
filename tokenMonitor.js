// src/tokenMonitor.js
// 代币生命周期管理
//
// ── 旧策略残留问题的根本原因与修复 ────────────────────────────────────
//
// 问题：tokenStore.on('newCandle', handler) 每次 onTokenReceived 都新增一个
//       监听器，pm2 reload（热重载）时旧监听器不会被清除，导致：
//         - 同一根 K 线被多个 handler 处理（旧+新策略同时执行）
//         - addPositionOpen / RSI 等旧字段如果内存未清空继续触发旧逻辑
//
// 修复方案：
//   1. 用具名函数 + removeListener 替代匿名 on（防止重复注册）
//   2. onTokenReceived 开始时清除该 address 的旧监听器
//   3. tokenStore.addToken 严格清零所有状态字段（含旧版遗留字段）
//   4. startAgeTicker 启动时扫描并清理内存中的旧版 token 脏字段

const config        = require('./config');
const tokenStore    = require('./tokenStore');
const birdeyeRest   = require('./birdeyeRest');
const birdeyeWs     = require('./birdeyeWs');
const webhookSender = require('./webhookSender');
const { evaluateStrategy } = require('./strategy');

// 每个 address 对应一个具名 candle handler，便于 removeListener
const _candleHandlers = new Map();

// ── 年龄计时器 ────────────────────────────────────────────────────
function startAgeTicker() {
  // 启动时先扫描内存中所有 token，清除旧版遗留字段
  _cleanLegacyFields();

  setInterval(async () => {
    const now    = Date.now();
    const maxAge = config.monitor.tokenMaxAgeMinutes * 60 * 1000;

    for (const token of tokenStore.getActiveTokens()) {
      const age = Math.floor((now - token.addedAt) / 60000);
      tokenStore.updateTokenData(token.address, { age });

      if (now - token.addedAt >= maxAge) {
        console.log(`[Monitor] AGE_EXPIRE: ${token.symbol} (${age}m)`);

        // 先注销 candle 监听器，再 unsubscribe WS，最后发信号
        _removeCandleHandler(token.address);
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

// ── REST 兜底轮询 ──────────────────────────────────────────────────
function startRestFallback(address) {
  const interval = setInterval(async () => {
    const token = tokenStore.getToken(address);
    if (!token || !token.active) { clearInterval(interval); return; }
    if (birdeyeWs.connected) return;
    const price = await birdeyeRest.getPrice(address);
    if (price && price > 0) tokenStore.updateTokenData(address, { price });
  }, 10000);
}

// ── 新代币入列主流程 ───────────────────────────────────────────────
async function onTokenReceived({ address, symbol, network }) {
  console.log(`[Monitor] New token: ${symbol} (${address})`);

  // ① 先注销该 address 可能存在的旧 candle 监听器（防重复注册）
  _removeCandleHandler(address);

  // ② 拉取元数据
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

  // ③ 立即买入首仓（hasBought 防止重复买入）
  if (token.hasBought) {
    console.log(`[Monitor] SKIP already bought: ${symbol}`);
    return;
  }
  const entryPrice = token.price;
  await webhookSender.sendBuy(address, symbol, 'FIRST_POSITION', entryPrice);
  tokenStore.updateTokenData(address, {
    hasBought:       true,     // 锁定，监控期内不再重复买
    positionOpen:    true,
    isFirstPosition: true,
    entryPrice:      entryPrice,
    entryAt:         Date.now(),
  });
  console.log(`[Monitor] FIRST_POSITION entry=$${entryPrice} ${symbol}`);

  // ④ 注册具名 candle handler（确保每个 address 只有一个）
  const handler = async ({ address: addr, candle }) => {
    if (addr !== address) return;
    const t = tokenStore.getToken(addr);
    if (!t || !t.active) return;
    await evaluateStrategy(addr, candle);
  };
  _candleHandlers.set(address, handler);
  tokenStore.on('newCandle', handler);

  // ⑤ 订阅 WS + REST 兜底
  birdeyeWs.subscribe(address);
  startRestFallback(address);
}

// ── 工具函数 ──────────────────────────────────────────────────────

function _removeCandleHandler(address) {
  const old = _candleHandlers.get(address);
  if (old) {
    tokenStore.removeListener('newCandle', old);
    _candleHandlers.delete(address);
    console.log(`[Monitor] Removed old candle handler for ${address}`);
  }
}

// 清除内存中 token 的旧版遗留字段（RSI、addPosition 等）
// 防止 pm2 reload 后旧字段仍在内存中驱动旧逻辑
function _cleanLegacyFields() {
  let cleaned = 0;
  for (const token of tokenStore.getAllTokens()) {
    const legacy = [
      'rsi', 'prevRsi',
      'addPositionOpen', 'addEntryPrice', 'additionCount',
      'firstPosSold', 'firstPosStopLoss',
      'hasBought',
    ];
    let dirty = false;
    for (const f of legacy) {
      if (f in token) { delete token[f]; dirty = true; }
    }
    if (dirty) cleaned++;
  }
  if (cleaned > 0) {
    console.log(`[Monitor] Cleaned legacy fields from ${cleaned} tokens`);
  }
}

module.exports = {
  onTokenReceived,
  startAgeTicker,
  _removeCandleHandlerExternal: _removeCandleHandler, // apiServer remove-token 用
};
