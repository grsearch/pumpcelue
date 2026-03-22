// src/strategy.js
// RSI(7) 交易策略
//
// 买入：RSI(7) 上穿 30（prevRsi<30 且 rsi>=30）
//       无持仓时触发，卖出后可再次买入（监控期内不限次数）
//
// 卖出（持仓中任一条件触发）：
//   1. K线 high 相对入场价 +50%  → 止盈
//   2. RSI 下穿 70               → 卖出
//   3. RSI > 80                  → 卖出
//   4. K线 low  相对入场价 -50%  → 止损
//
// 白名单退出（由 tokenMonitor 负责，不在此处理）：
//   - 监控满 60 分钟
//   - LP < 10000

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
  const low   = (candle && candle.low)  ? candle.low  : price;

  // ── 持仓中：检查卖出条件 ─────────────────────────────────────────
  if (token.addPositionOpen) {

    // 入场价兜底
    if (!token.addEntryPrice && price) {
      token.addEntryPrice = price;
      console.log(`[Strategy] Entry price set: $${price} for ${token.symbol}`);
    }

    if (token.addEntryPrice) {
      const tpPrice = token.addEntryPrice * (1 + config.rsi.tpPct / 100);
      const slPrice = token.addEntryPrice * (1 - config.rsi.slPct / 100);

      // 卖出条件 1：+50% 止盈（用 high 判断）
      if (high >= tpPrice) {
        const exitPrice = tpPrice;
        const gainPct   = ((exitPrice - token.addEntryPrice) / token.addEntryPrice * 100).toFixed(1);
        console.log(`[Strategy] SELL TP +${gainPct}%: ${token.symbol} entry=$${token.addEntryPrice} high=$${high}`);
        await webhookSender.sendSell(address, token.symbol, `TP_+${config.rsi.tpPct}%`, exitPrice);
        _clearPosition(token);
        return;
      }

      // 卖出条件 2：RSI > 80
      if (rsi > config.rsi.sellHigh) {
        console.log(`[Strategy] SELL RSI>${config.rsi.sellHigh}: ${token.symbol} RSI=${rsi.toFixed(2)}`);
        await webhookSender.sendSell(address, token.symbol, `RSI_ABOVE_${config.rsi.sellHigh}`, price);
        _clearPosition(token);
        return;
      }

      // 卖出条件 3：RSI 下穿 70
      if (prevRsi >= config.rsi.sellCross && rsi < config.rsi.sellCross) {
        console.log(`[Strategy] SELL RSI cross↓${config.rsi.sellCross}: ${token.symbol} RSI=${rsi.toFixed(2)}`);
        await webhookSender.sendSell(address, token.symbol, `RSI_CROSS_DOWN_${config.rsi.sellCross}`, price);
        _clearPosition(token);
        return;
      }

      // 卖出条件 4：-50% 止损（用 low 判断）
      if (low <= slPrice) {
        const exitPrice = slPrice;
        const lossPct   = ((exitPrice - token.addEntryPrice) / token.addEntryPrice * 100).toFixed(1);
        console.log(`[Strategy] SELL SL ${lossPct}%: ${token.symbol} entry=$${token.addEntryPrice} low=$${low}`);
        await webhookSender.sendSell(address, token.symbol, `SL_-${config.rsi.slPct}%`, exitPrice);
        _clearPosition(token);
        return;
      }

      // 更新浮盈显示
      token.pnl = parseFloat(((price - token.addEntryPrice) / token.addEntryPrice * 100).toFixed(2));
    }
  }

  // ── 无持仓：RSI 上穿 30 → 买入 ───────────────────────────────────
  // 卖出后允许再次买入，监控期内不限次数（无 hasBought 限制）
  if (!token.addPositionOpen &&
      prevRsi < config.rsi.buyCross &&
      rsi >= config.rsi.buyCross) {
    if (!token.active) return;
    console.log(`[Strategy] BUY (RSI cross↑${config.rsi.buyCross}): ${token.symbol} RSI=${rsi.toFixed(2)} price=$${price}`);
    await webhookSender.sendBuy(address, token.symbol, `RSI_CROSS_UP_${config.rsi.buyCross}`, price);
    token.addPositionOpen = true;
    token.addEntryPrice   = price;
    token.pnl             = 0;
    token.additionCount++;
  }
}

function _clearPosition(token) {
  token.addPositionOpen = false;
  token.addEntryPrice   = null;
  token.pnl             = 0;
  token.sellCount++;
}

module.exports = { calcRSI, evaluateStrategy };
