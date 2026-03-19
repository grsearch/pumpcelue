# SOL Monitor — 5s Candle Strategy System

实时监控 Solana 新币，通过 BirdEye WebSocket 成交流本地聚合 5s K 线，
RSI(7) 策略自动发送买卖 Webhook 信号。

---

## 系统架构

```
扫描服务器
    │  POST /webhook/add-token
    ▼
SOL Monitor（本服务，端口 3003）
    │
    ├─ BirdEye REST   → 拉取 LP / FDV / 历史 1m K 线（RSI 预热）
    │
    └─ BirdEye WS     → SUBSCRIBE_TXS 成交流
           每笔成交 → 本地聚合 5s K 线 → RSI(7) 策略
                                               │
                                    ┌──────────┴──────────┐
                                    ▼                     ▼
                             BUY Webhook            SELL Webhook
                    POST /webhook/new-token     POST /force-sell
                         （交易机器人）
```

---

## 快速开始

### 1. 上传代码 / Clone

```bash
git clone <your-repo-url> sol-monitor
cd sol-monitor
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置

```bash
cp .env.example .env
vim .env          # 至少填写 BIRDEYE_API_KEY 和 TRADE_BOT_HOST/PORT
```

### 4. 启动

```bash
# 直接运行
npm start

# 推荐：PM2 守护进程
npm install -g pm2
pm2 start src/index.js --name sol-monitor
pm2 save
pm2 startup        # 设置开机自启
```

---

## API 接口

### 接收新代币（来自扫描服务器）

```bash
curl -X POST http://SERVER_IP:3003/webhook/add-token \
  -H "Content-Type: application/json" \
  -d '{"network":"solana","address":"BWJ7zJauzatao4FsBnGdVsqdBi3k5NbgSY62noZApump","symbol":"Nana"}'
```

响应（立即返回 202，后台异步处理）：
```json
{"success":true,"message":"Token queued for monitoring","address":"...","symbol":"Nana"}
```

### 查看白名单

```bash
curl http://SERVER_IP:3003/api/tokens
```

### 查看信号记录

```bash
curl http://SERVER_IP:3003/api/signals
```

### 系统状态

```bash
curl http://SERVER_IP:3003/api/status
```

### 手动移除代币（会先发 SELL 信号）

```bash
curl -X POST http://SERVER_IP:3003/api/remove-token \
  -H "Content-Type: application/json" \
  -d '{"address":"代币合约地址"}'
```

---

## 向交易机器人发送的信号格式

### BUY 信号
```
POST http://TRADE_BOT:3002/webhook/new-token
{"mint":"代币地址","symbol":"代币符号"}
```

### SELL 信号
```
POST http://TRADE_BOT:3002/force-sell
{"mint":"代币地址","signal":"SELL"}
```

---

## 交易策略

```
代币入列
  │
  └─► 立即 BUY【FIRST_POSITION】
        │
        ├─ 价格 +50%  ──────────────────► SELL【FIRST_POSITION_TP_+50%】
        │
        └─ RSI(7) 上穿 30 ──────────────► BUY【RSI_CROSS_UP_30】（加仓）
                │                              │
                │                        isFirstPosition = false
                │                              │
                │                    ┌─────────┴─────────┐
                │                    ▼                   ▼
                │               RSI > 80           RSI 下穿 70
                │            SELL【RSI_ABOVE_80】  SELL【RSI_CROSS_DOWN_70】
                │
                └─ Age > 30min ─────────────────► SELL【AGE_EXPIRE】+ 移出白名单
```

| 策略标记 | 触发条件 | 信号类型 |
|---------|---------|---------|
| `FIRST_POSITION` | 代币入列立即触发 | BUY |
| `FIRST_POSITION_TP_+50%` | 首仓价格上涨 50% | SELL |
| `RSI_CROSS_UP_30` | RSI(7) 上穿 30 | BUY（加仓） |
| `RSI_ABOVE_80` | RSI(7) > 80（加仓仓位） | SELL |
| `RSI_CROSS_DOWN_70` | RSI(7) 下穿 70（加仓仓位） | SELL |
| `AGE_EXPIRE` | 监控时长 > 30 分钟 | SELL |
| `MANUAL_REMOVE` | Dashboard 手动移除 | SELL |

---

## 5s K 线聚合原理

BirdEye REST 不提供 5s 历史 K 线，使用 WebSocket 成交流本地聚合：

```
成交推送（每笔）
    │
    ├─ windowStart = floor(blockUnixTime / 5) * 5
    │
    ├─ 同一窗口 → 更新 high / low / close / volume
    │
    └─ 新窗口 → 封口旧窗口 → emit newCandle → 计算 RSI
               → 补填无成交空窗口（用上根收盘价填充，保持 RSI 连续）
               → 开启新窗口
```

**RSI 预热：** 启动时用 BirdEye REST 拉取最近 50 根 1m K 线预热 RSI，
对新币历史不足时由 WS 实时数据自然积累（约 45s 后 RSI 就绪）。

---

## Dashboard

浏览器访问 `http://SERVER_IP:3003/`

| 列 | 说明 |
|---|---|
| Symbol | 代币符号，绿点表示有持仓 |
| Age | 监控时长（分钟），>20m 变黄，>25m 变红 |
| LP | 流动池规模（美元） |
| FDV | 完全稀释估值 |
| Price | 最新成交价 |
| RSI(7) | 当前 RSI 值，红色=超买，绿色=超卖 |
| Position | 首仓(1st) / 加仓(Add) / 无仓位 |
| PnL | 首仓浮动盈亏 % |
| Contract | 合约地址，点击跳转 GMGN |

---

## 腾讯云防火墙配置

安全组入站规则开放：

| 端口 | 协议 | 用途 |
|------|------|------|
| 3003 | TCP | Webhook 接收 + Dashboard |

---

## 环境变量说明

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BIRDEYE_API_KEY` | — | BirdEye API Key（**必填**） |
| `HELIUS_API_KEY` | — | Helius API Key（预留） |
| `PORT` | 3003 | 服务监听端口 |
| `TRADE_BOT_HOST` | localhost | 交易机器人 IP |
| `TRADE_BOT_PORT` | 3002 | 交易机器人端口 |
| `TOKEN_MAX_AGE_MINUTES` | 30 | 代币最大监控时长（分钟） |
| `CANDLE_INTERVAL_SECONDS` | 5 | K 线聚合周期（秒） |
| `RSI_PERIOD` | 7 | RSI 计算周期 |
| `RSI_BUY_CROSS` | 30 | RSI 加仓上穿阈值 |
| `RSI_SELL_HIGH` | 80 | RSI 超买卖出阈值 |
| `RSI_SELL_CROSS` | 70 | RSI 死叉卖出阈值 |
| `FIRST_POSITION_TP_PCT` | 50 | 首仓止盈百分比 |
