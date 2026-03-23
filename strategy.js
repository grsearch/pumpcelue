// src/strategy.js
// 策略：EMA9 下穿 EMA20 且 EMA20 走平或下行时卖出（死叉策略）
//
// 卖出条件（两个同时满足）：
//   1. EMA9 从上方下穿 EMA20（本根 EMA9 < EMA20，上根 EMA9 >= EMA20）
//   2. EMA20 走平或下行（curr20 <= prev20 × 1.001，容差 0.1%）
//
// 过滤低位假死叉：价格在低位震荡时 EMA20 仍在上行，条件2不满足，不触发卖出

const tokenStore    = require('./tokenStore');
const webhookSender = require('./webhookSender');

// ── EMA 计算 ──────────────────────────────────────────────────────
function calcEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// 同时返回当前和上一根 K 线的 EMA9 / EMA20
function calcEMAPair(closes) {
  if (!closes || closes.length < 22) {
    return null;
  }
  const curr9  = calcEMA(closes, 9);
  const curr20 = calcEMA(closes, 20);
  const prev9  = calcEMA(closes.slice(0, -1), 9);
  const prev20 = calcEMA(closes.slice(0, -1), 20);
  if (curr9 === null || curr20 === null || prev9 === null || prev20 === null) return null;
  return { curr9, curr20, prev9, prev20 };
}

// ── 策略主函数（每次 REST 轮询拿到新 K 线后调用）────────────────────
async function evaluateStrategy(address, candle) {
  const token = tokenStore.getToken(address);
  if (!token || !token.active) return;
  if (!token.positionOpen)     return;
  if (!token.entryPrice)       return;

  const closes = token.closes;
  if (!closes || closes.length < 22) {
    console.log(`[Strategy] SKIP ${token.symbol}: closes=${closes?.length ?? 0} < 22, waiting for more data`);
    return;
  }

  const ema = calcEMAPair(closes);
  if (!ema) return;

  const { curr9, curr20, prev9, prev20 } = ema;

  // 实时更新 EMA（供 tokenMonitor 广播到 Dashboard）
  token.ema9  = curr9;
  token.ema20 = curr20;

  // 更新浮盈
  if (token.price) {
    token.pnl = parseFloat(
      ((token.price - token.entryPrice) / token.entryPrice * 100).toFixed(2)
    );
  }

  // ── 卖出判断 ──────────────────────────────────────────────────────
  const isCrossDown = prev9 >= prev20 && curr9 < curr20;  // 条件1：EMA9 死叉
  const ema20Flat   = curr20 <= prev20 * 1.001;           // 条件2：EMA20 走平或下行

  if (isCrossDown && ema20Flat) {
    console.log(
      `[Strategy] SELL EMA死叉: ${token.symbol} | ` +
      `EMA9 ${prev9.toFixed(8)}→${curr9.toFixed(8)} | ` +
      `EMA20 ${prev20.toFixed(8)}→${curr20.toFixed(8)} | ` +
      `price=$${token.price}`
    );
    await webhookSender.sendSell(
      address, token.symbol, 'EMA9_CROSS_DOWN_EMA20', token.price
    );
    token.positionOpen    = false;
    token.isFirstPosition = false;
    token.entryPrice      = null;
    token.ema9            = null;
    token.ema20           = null;
    token.pnl             = 0;
    token.sellCount++;
  } else {
    console.log(
      `[Strategy] ${token.symbol} | ` +
      `EMA9=${curr9.toFixed(8)} EMA20=${curr20.toFixed(8)} | ` +
      `crossDown=${isCrossDown} ema20Flat=${ema20Flat} | no signal`
    );
  }
}

module.exports = { evaluateStrategy, calcEMA };
