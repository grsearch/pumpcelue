// src/strategy.js
// 纯首仓策略：+150% 止盈，无 RSI 加仓
//
// ┌─ 逻辑说明 ───────────────────────────────────────────────────────┐
// │  代币入列 → 立即 BUY（FIRST_POSITION）                           │
// │                                                                  │
// │  持仓期间每根 K 线检查：                                          │
// │    K 线 high >= 首仓入场价 × 2.5 → SELL TP_+150%                │
// │    （实时成交价检查在 birdeyeWs._checkTakeProfit 中处理）         │
// │                                                                  │
// │  退出：                                                           │
// │    30 分钟到期 → tokenMonitor.startAgeTicker 发 SELL AGE_EXPIRE  │
// └──────────────────────────────────────────────────────────────────┘

const config        = require('./config');
const tokenStore    = require('./tokenStore');
const webhookSender = require('./webhookSender');

async function evaluateStrategy(address, candle) {
  const token = tokenStore.getToken(address);
  if (!token || !token.active)        return;
  if (!token.positionOpen)            return;
  if (!token.entryPrice)              return;

  const high = (candle && candle.high) ? candle.high : token.price;
  if (!high) return;

  // 更新浮盈显示
  if (token.price) {
    token.pnl = parseFloat(
      ((token.price - token.entryPrice) / token.entryPrice * 100).toFixed(2)
    );
  }

  const tpPrice = token.entryPrice * (1 + config.rsi.tpPct / 100);

  if (high >= tpPrice) {
    console.log(
      `[Strategy] SELL TP +${config.rsi.tpPct}%: ${token.symbol} ` +
      `high=$${high.toFixed(8)} entry=$${token.entryPrice.toFixed(8)}`
    );
    await webhookSender.sendSell(address, token.symbol, `TP_+${config.rsi.tpPct}%`, tpPrice);
    token.positionOpen    = false;
    token.isFirstPosition = false;
    token.entryPrice      = null;
    token.pnl             = 0;
    token.sellCount++;
  }
}

module.exports = { evaluateStrategy };
