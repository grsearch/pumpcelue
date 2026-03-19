// src/strategy.js
// RSI(7) 计算 + 交易策略信号
//
// 仓位类型：
//   isFirstPosition = true  → 仅 +50% 止盈卖出 (FIRST_POSITION_TP)
//   isFirstPosition = false → RSI > 80 或 RSI 下穿 70 卖出
//
// 加仓：
//   RSI(7) 上穿 30 → BUY (RSI_CROSS_UP_30)
//   加仓后 isFirstPosition 置为 false，使用 RSI 卖出规则

const { RSI }    = require('technicalindicators');
const config     = require('./config');
const tokenStore = require('./tokenStore');
const webhookSender = require('./webhookSender');

const RSI_PERIOD = config.rsi.period; // 7

/**
 * 计算 RSI，数据不足时返回 null
 */
function calcRSI(closes) {
  if (closes.length < RSI_PERIOD + 1) return null;
  const values = RSI.calculate({ values: closes, period: RSI_PERIOD });
  if (!values || values.length === 0) return null;
  return values[values.length - 1];
}

/**
 * 每根 5s K 线封口后调用，执行策略判断
 */
async function evaluateStrategy(address) {
  const token = tokenStore.getToken(address);
  if (!token || !token.active) return;

  const closes = token.closes;
  // 需要 period+2 根才能判断交叉（当前值 + 前一值）
  if (closes.length < RSI_PERIOD + 2) return;

  const rsi = calcRSI(closes);
  if (rsi === null) return;

  const prevRsi    = token.rsi; // 上一根 K 线的 RSI
  token.prevRsi    = prevRsi;
  token.rsi        = rsi;

  const price = token.price || closes[closes.length - 1];

  // ── 首仓：+50% 止盈 ──────────────────────────────────────────────
  // RSI 卖出逻辑对首仓无效，只有价格涨 50% 才触发卖出
  if (token.positionOpen && token.isFirstPosition) {
    // 入场价兜底：若 REST 拉取时价格尚未就绪，在此补录
    if (!token.firstPositionEntryPrice && price) {
      token.firstPositionEntryPrice = price;
      console.log(`[Strategy] Entry price captured from WS: $${price} for ${token.symbol}`);
    }

    if (token.firstPositionEntryPrice && price) {
      const gainPct = ((price - token.firstPositionEntryPrice) / token.firstPositionEntryPrice) * 100;
      token.pnl = parseFloat(gainPct.toFixed(2));

      if (gainPct >= config.rsi.firstPositionTpPct) {
        console.log(
          `[Strategy] SELL (First Position TP +${gainPct.toFixed(1)}%): ` +
          `${token.symbol} entry=$${token.firstPositionEntryPrice} now=$${price}`
        );
        await webhookSender.sendSell(
          address, token.symbol,
          `FIRST_POSITION_TP_+${config.rsi.firstPositionTpPct}%`,
          price
        );
        token.positionOpen    = false;
        token.isFirstPosition = false;
        token.sellCount++;
        // 不 return：同一根 K 线允许继续检查 RSI 加仓信号
      }
    }
  }

  // ── 加仓仓位：RSI 卖出 ───────────────────────────────────────────
  if (token.positionOpen && !token.isFirstPosition) {
    // 卖出条件 1：RSI > 80
    if (rsi > config.rsi.sellHigh) {
      console.log(`[Strategy] SELL (RSI>${config.rsi.sellHigh}): ${token.symbol} RSI=${rsi.toFixed(2)}`);
      await webhookSender.sendSell(
        address, token.symbol,
        `RSI_ABOVE_${config.rsi.sellHigh}`,
        price
      );
      token.positionOpen = false;
      token.sellCount++;
      return;
    }

    // 卖出条件 2：RSI 下穿 70
    if (prevRsi !== null && prevRsi >= config.rsi.sellCross && rsi < config.rsi.sellCross) {
      console.log(`[Strategy] SELL (RSI cross↓${config.rsi.sellCross}): ${token.symbol} RSI=${rsi.toFixed(2)}`);
      await webhookSender.sendSell(
        address, token.symbol,
        `RSI_CROSS_DOWN_${config.rsi.sellCross}`,
        price
      );
      token.positionOpen = false;
      token.sellCount++;
      return;
    }
  }

  // ── 新仓：RSI(7) 上穿 30，且当前无持仓 ────────────────────────────
  // 规则：
  //   1. 必须 positionOpen = false（无持仓才能开新仓，防止重复加仓）
  //   2. RSI 从 30 以下上穿 30
  //   3. 卖出后再次满足条件可重新开仓（无次数限制）
  if (!token.positionOpen &&
      prevRsi !== null && prevRsi < config.rsi.buyCross && rsi >= config.rsi.buyCross) {
    // 异步 await 期间检查 token 是否已被到期移除
    if (!token.active) return;
    console.log(`[Strategy] BUY NEW (RSI cross↑${config.rsi.buyCross}): ${token.symbol} RSI=${rsi.toFixed(2)}`);
    await webhookSender.sendBuy(
      address, token.symbol,
      `RSI_CROSS_UP_${config.rsi.buyCross}`,
      price
    );
    token.additionCount++;
    token.positionOpen    = true;
    token.isFirstPosition = false;
  }
}

module.exports = { calcRSI, evaluateStrategy };
