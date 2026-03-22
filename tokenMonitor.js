// src/tokenMonitor.js
// 代币生命周期管理：接收新代币、拉取元数据、订阅 WS、年龄到期退出

const config        = require('./config');
const tokenStore    = require('./tokenStore');
const birdeyeRest   = require('./birdeyeRest');
const birdeyeWs     = require('./birdeyeWs');
const webhookSender = require('./webhookSender');
const { evaluateStrategy } = require('./strategy');

// 年龄计时器：每分钟更新所有 active token 的 age，到期发 SELL 并移除
function startAgeTicker() {
  setInterval(async () => {
    const now    = Date.now();
    const maxAge = config.monitor.tokenMaxAgeMinutes * 60 * 1000;

    for (const token of tokenStore.getActiveTokens()) {
      const age = Math.floor((now - token.addedAt) / 60000);
      tokenStore.updateTokenData(token.address, { age });

      if (now - token.addedAt >= maxAge) {
        console.log(`[Monitor] AGE_EXPIRE: ${token.symbol} (${age}m)`);

        // 停止订阅
        birdeyeWs.unsubscribe(token.address);
        tokenStore.removeToken(token.address);

        // 有任何持仓都发 SELL 信号
        if (token.positionOpen || token.addPositionOpen) {
          await webhookSender.sendSell(
            token.address,
            token.symbol,
            'AGE_EXPIRE',
            token.price
          );
        }
      }
    }
  }, 60 * 1000);
}

// REST 兜底轮询：WS 断线期间每 10s 拉一次价格，保持价格更新
function startRestFallback(address) {
  const interval = setInterval(async () => {
    const token = tokenStore.getToken(address);
    if (!token || !token.active) {
      clearInterval(interval);
      return;
    }
    // WS 已连接时不重复拉取
    if (birdeyeWs.connected) return;

    const price = await birdeyeRest.getPrice(address);
    if (price && price > 0) {
      tokenStore.updateTokenData(address, { price });
    }
  }, 10000);
}

// 新代币入列主流程
async function onTokenReceived({ address, symbol, network }) {
  console.log(`[Monitor] New token: ${symbol} (${address})`);

  // 1. 拉取元数据（LP / FDV / 价格）
  const overview = await birdeyeRest.getTokenOverview(address);
  if (overview) {
    tokenStore.updateTokenData(address, {
      price:       overview.price,
      lp:          overview.lp,
      fdv:         overview.fdv,
      priceChange: overview.priceChange,
    });

    // FDV 过滤
    if (overview.fdv && overview.fdv < config.monitor.fdvMinimum) {
      console.log(`[Monitor] SKIP low FDV $${overview.fdv}: ${symbol}`);
      tokenStore.removeToken(address);
      return;
    }
  }

  // 2. 立即买入首仓（FIRST_POSITION）
  const token = tokenStore.getToken(address);
  if (!token || !token.active) return;

  await webhookSender.sendBuy(address, symbol, 'FIRST_POSITION', token.price);
  tokenStore.updateTokenData(address, {
    positionOpen:    true,
    isFirstPosition: true,
    entryPrice:      token.price,
    firstPosSold:    false,
  });

  // 3. RSI 预热：拉取 50 根 1m K 线
  const ohlcv = await birdeyeRest.getOHLCV(address, 50);
  if (ohlcv && ohlcv.length > 0) {
    for (const bar of ohlcv) {
      tokenStore.pushClose(address, bar.c ?? bar.close);
    }
    console.log(`[Monitor] RSI warm-up: ${ohlcv.length} candles loaded for ${symbol}`);
  }

  // 4. 订阅 WS 成交流
  birdeyeWs.subscribe(address);

  // 5. 启动 REST 兜底轮询
  startRestFallback(address);

  // 6. 监听 newCandle 事件 → 跑策略
  tokenStore.on('newCandle', async ({ address: addr, candle, token: t }) => {
    if (addr !== address) return;
    await evaluateStrategy(addr, candle);
    tokenStore.emit('tokenUpdated', tokenStore.getToken(addr) || t);
  });
}

module.exports = { onTokenReceived, startAgeTicker };
