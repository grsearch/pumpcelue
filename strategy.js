// src/strategy.js
// RSI(7) 交易策略
//
// 买入：RSI(7) 上穿 30（prevRsi<30 且 rsi>=30）
//       监控期内只买一次（hasBought=true 后不再触发）
//
// 卖出：K线 high 相对入场价 +50% → 止盈
//
// 白名单退出（由 tokenMonitor 负责）：
//   - 监控满 60 分钟 → AGE_EXPIRE
//   - FDV < 10000   → FDV_TOO_LOW

const { RSI }       = require('technicalindicators');
const config        = require('./config');
const tokenStore    = require('./tokenStore');
const webhookSender = require('./webhookSender');

const RSI_PERIOD = config.rsi.period; // 7

function calcRSI(closes) {
  if (closes.length < RSI_PERIOD + 1) return null;
  const values = RSI.calculate({ values: closes, period: RSI_PERIOD });
  if (!values || values.length === 0) return null;
  return values[values.length - 1];
}

async function evaluateStrategy(address, candle) {
  const token = tokenStore.getToken(address);
  if (!token || !token.active) return;

  const closes = token.closes;
  if (closes.length < RSI_PERIOD + 2) return;

  const rsi = calcRSI(closes);
  if (rsi === null) return;

  const prevCloses = closes.slice(0, -1);
  const prevRsi    = prevCloses.length >= RSI_PERIOD + 1 ? calcRSI(prevCloses) : null;

  token.prevRsi = prevRsi;
  token.rsi     = rsi;

  if (prevRsi === null) return;

  const price = token.price || closes[closes.length - 1];
  const high  = (candle && candle.high) ? candle.high : price;

  // ── 持仓中：+50% 止盈 ────────────────────────────────────────────
  if (token.addPositionOpen) {

    if (!token.addEntryPrice && price) {
      token.addEntryPrice = price;
      console.log(`[Strategy] Entry price set: $${price} for ${token.symbol}`);
    }

    if (token.addEntryPrice) {
      const tpPrice = token.addEntryPrice * (1 + config.rsi.tpPct / 100);

      // 用 high 判断止盈，避免漏掉 K 线内瞬间触及止盈价
      if (high >= tpPrice) {
        const gainPct = ((tpPrice - token.addEntryPrice) / token.addEntryPrice * 100).toFixed(1);
        console.log(`[Strategy] SELL TP +${gainPct}%: ${token.symbol} entry=$${token.addEntryPrice} high=$${high}`);
        await webhookSender.sendSell(address, token.symbol, `TP_+${config.rsi.tpPct}%`, tpPrice);
        token.addPositionOpen = false;
        token.addEntryPrice   = null;
        token.pnl             = 0;
        token.sellCount++;
        return;
      }

      // 更新浮盈显示
      token.pnl = parseFloat(((price - token.addEntryPrice) / token.addEntryPrice * 100).toFixed(2));
    }
  }

  // ── 无持仓且未买过：RSI 上穿 30 → 买入 ──────────────────────────
  if (!token.addPositionOpen && !token.hasBought &&
      prevRsi < config.rsi.buyCross &&
      rsi >= config.rsi.buyCross) {
    if (!token.active) return;
    console.log(`[Strategy] BUY (RSI cross↑${config.rsi.buyCross}): ${token.symbol} RSI=${rsi.toFixed(2)} price=$${price}`);
    await webhookSender.sendBuy(address, token.symbol, `RSI_CROSS_UP_${config.rsi.buyCross}`, price);
    token.addPositionOpen = true;
    token.addEntryPrice   = price;
    token.hasBought       = true;
    token.pnl             = 0;
    token.additionCount++;
  }
}

module.exports = { calcRSI, evaluateStrategy };
