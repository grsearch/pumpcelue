// src/strategy.js
// RSI(7) 交易策略
//
// ┌─ 代币入列 ──────────────────────────────────────────────────────┐
// │  立即 BUY（FIRST_POSITION），positionOpen=true，isFirstPos=true  │
// │                                                                 │
// │  首仓卖出规则（isFirstPosition=true）：                           │
// │    价格相对首仓入场价 +50% → SELL（TP_+50%）                      │
// │    RSI > 80、RSI 下穿 70  → 不触发（首仓通常在 RSI 高位买入）      │
// │                                                                 │
// │  加仓规则（独立于首仓是否持有）：                                   │
// │    RSI(7) 上穿 30（prevRsi<30 且 rsi>=30）→ BUY                  │
// │    addPositionOpen=false 时才触发（防同一周期重复买）              │
// │    上穿的定义本身已保证 RSI 曾低于 30，无需额外冷却标志             │
// │                                                                 │
// │  加仓卖出规则（addPositionOpen=true）：                            │
// │    价格相对加仓入场价 +50% → SELL（TP_+50%）                      │
// │    RSI > 80               → SELL（RSI_ABOVE_80）                │
// │    RSI 下穿 70             → SELL（RSI_CROSS_DOWN_70）           │
// │    卖出后 addPositionOpen=false，等下次 RSI 上穿 30 再开           │
// │                                                                 │
// │  Age > 60min → SELL（AGE_EXPIRE）+ 移出白名单                    │
// └─────────────────────────────────────────────────────────────────┘

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

async function evaluateStrategy(address) {
  const token = tokenStore.getToken(address);
  if (!token || !token.active) return;

  const closes = token.closes;
  // 需要 period+2 根才能同时得到 prevRsi 和 rsi，用于判断交叉
  if (closes.length < RSI_PERIOD + 2) return;

  const rsi = calcRSI(closes);
  if (rsi === null) return;

  // prevRsi：直接从 closes 的倒数第二个位置计算，不依赖上次存的 token.rsi
  // 这样即使是第一次进入，只要 closes 够长，prevRsi 就一定有值
  const prevCloses = closes.slice(0, -1);
  const prevRsi    = prevCloses.length >= RSI_PERIOD + 1 ? calcRSI(prevCloses) : null;

  token.prevRsi = prevRsi;
  token.rsi     = rsi;

  // prevRsi 仍不足时（closes 刚好在边界），等下一根
  if (prevRsi === null) return;

  const price = token.price || closes[closes.length - 1];

  // ── 首仓：仅 +50% 止盈 ───────────────────────────────────────────
  // RSI 信号对首仓完全不生效（首仓买入时 RSI 通常在高位）
  if (token.positionOpen && token.isFirstPosition) {
    // 入场价兜底：REST 未及时返回时由此补录
    if (!token.entryPrice && price) {
      token.entryPrice = price;
      console.log(`[Strategy] First position entry price: $${price} for ${token.symbol}`);
    }

    if (token.entryPrice && price) {
      const gainPct = ((price - token.entryPrice) / token.entryPrice) * 100;
      token.pnl = parseFloat(gainPct.toFixed(2));

      if (gainPct >= config.rsi.firstPositionTpPct) {
        console.log(
          `[Strategy] SELL first pos (TP +${gainPct.toFixed(1)}%): ` +
          `${token.symbol} entry=$${token.entryPrice} now=$${price}`
        );
        await webhookSender.sendSell(
          address, token.symbol,
          `TP_+${config.rsi.firstPositionTpPct}%`,
          price
        );
        token.positionOpen    = false;
        token.isFirstPosition = false;
        token.entryPrice      = null;
        token.pnl             = 0;
        token.sellCount++;
        // 机器人收到 SELL 会全仓卖出，加仓也一并清除，否则系统进入僵死状态
        if (token.addPositionOpen) {
          token.addPositionOpen = false;
          token.addEntryPrice   = null;
          console.log(`[Strategy] Add position also cleared due to first pos TP sell: ${token.symbol}`);
        }
        return;
      }
    }
  }

  // ── 加仓仓位：止盈 + RSI 卖出 ────────────────────────────────────
  if (token.addPositionOpen) {
    // 加仓入场价兜底
    if (!token.addEntryPrice && price) {
      token.addEntryPrice = price;
    }

    if (token.addEntryPrice && price) {
      const gainPct = ((price - token.addEntryPrice) / token.addEntryPrice) * 100;

      // 卖出条件 1：+50% 止盈
      if (gainPct >= config.rsi.firstPositionTpPct) {
        console.log(
          `[Strategy] SELL add pos (TP +${gainPct.toFixed(1)}%): ` +
          `${token.symbol} entry=$${token.addEntryPrice} now=$${price}`
        );
        await webhookSender.sendSell(
          address, token.symbol,
          `TP_+${config.rsi.firstPositionTpPct}%`,
          price
        );
        token.addPositionOpen = false;
        token.addEntryPrice   = null;
        token.sellCount++;
        // 机器人全仓卖出，首仓也一并清除
        if (token.positionOpen) {
          token.positionOpen    = false;
          token.isFirstPosition = false;
          token.entryPrice      = null;
          token.pnl             = 0;
        }
        return;
      }
    }

    // 卖出条件 2：RSI > 80
    if (rsi > config.rsi.sellHigh) {
      console.log(`[Strategy] SELL add pos (RSI>${config.rsi.sellHigh}): ${token.symbol} RSI=${rsi.toFixed(2)}`);
      await webhookSender.sendSell(
        address, token.symbol,
        `RSI_ABOVE_${config.rsi.sellHigh}`,
        price
      );
      token.addPositionOpen = false;
      token.addEntryPrice   = null;
      token.sellCount++;
      // 机器人全仓卖出，首仓也一并清除
      if (token.positionOpen) {
        token.positionOpen    = false;
        token.isFirstPosition = false;
        token.entryPrice      = null;
        token.pnl             = 0;
      }
      return;
    }

    // 卖出条件 3：RSI 下穿 70
    if (prevRsi >= config.rsi.sellCross && rsi < config.rsi.sellCross) {
      console.log(`[Strategy] SELL add pos (RSI cross↓${config.rsi.sellCross}): ${token.symbol} RSI=${rsi.toFixed(2)}`);
      await webhookSender.sendSell(
        address, token.symbol,
        `RSI_CROSS_DOWN_${config.rsi.sellCross}`,
        price
      );
      token.addPositionOpen = false;
      token.addEntryPrice   = null;
      token.sellCount++;
      // 机器人全仓卖出，首仓也一并清除
      if (token.positionOpen) {
        token.positionOpen    = false;
        token.isFirstPosition = false;
        token.entryPrice      = null;
        token.pnl             = 0;
      }
      return;
    }
  }

  // ── RSI(7) 上穿 30 → 加仓 ────────────────────────────────────────
  // 条件：
  //   1. addPositionOpen=false（无加仓仓位，防重复买）
  //   2. prevRsi < 30（上一根低于 30，本身已证明 RSI 曾低于 30）
  //   3. rsi >= 30（本根突破 30，形成上穿）
  // 不受首仓是否持有影响
  if (!token.addPositionOpen &&
      prevRsi < config.rsi.buyCross &&
      rsi >= config.rsi.buyCross) {
    if (!token.active) return;
    console.log(`[Strategy] BUY ADD (RSI cross↑${config.rsi.buyCross}): ${token.symbol} RSI=${rsi.toFixed(2)}`);
    await webhookSender.sendBuy(
      address, token.symbol,
      `RSI_CROSS_UP_${config.rsi.buyCross}`,
      price
    );
    token.addPositionOpen = true;
    token.addEntryPrice   = price;
    token.additionCount++;
  }
}

module.exports = { calcRSI, evaluateStrategy };
