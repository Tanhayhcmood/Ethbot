# Auto Token Deposit Detector & Forwarder

## نمای کلی

این ماژول یک افزونه (extension) برای بات انتقال اتریوم است که امکان تشخیص و انتقال خودکار واریز توکن‌ها را فراهم می‌کند.

## قابلیت‌ها

- ✅ تشخیص خودکار واریز توکن‌ها (ETH, USDT, USDC)
- ✅ سرعت تشخیص: کمتر از 1 ثانیه (event-driven)
- ✅ تشخیص خودکار نوع توکن واریز شده
- ✅ انتقال مقدار واریز شده به Wallet B
- ✅ تخمین داینامیک هزینه گس
- ✅ لاگ‌های کامل و جامع
- ✅ محافظت در برابر رویدادهای تکراری

## نحوه استفاده

### اجرای مستقل
```bash
node start_with_fee_switcher.js
```

### استفاده به عنوان ماژول
```javascript
const { initializeAutoFeeSwitcher } = require('./fee_switcher');

await initializeAutoFeeSwitcher({
  privateKey: process.env.PRIVATE_KEY,
  destinationAddress: process.env.DESTINATION_ADDRESS,
  provider: provider,
  monitoredAddress: walletAddress
});
```

## ساختار فایل‌ها

```
fee_switcher/
├── index.js              # Entry point
├── auto_fee_token.js     # Main orchestrator
├── deposit_listener.js   # Token deposit event listener
├── erc20_executor.js     # ERC20 transfer execution
├── token_registry.js     # Token definitions (USDT, USDC)
├── integration.js        # Integration helpers
└── README.md             # This documentation
```

## لاگ‌های خروجی

```
Detected deposit: {TOKEN}, switching network fee token → {TOKEN}
Dynamic gas fee estimated: {amount} {token}
Transfer executed successfully → Wallet B
```

## محدودیت مهم: پرداخت گس

در شبکه اتریوم، هزینه گس **همیشه** با ETH پرداخت می‌شود. این یک محدودیت فنی بلاکچین است.

این ماژول:
- واریز توکن‌ها را تشخیص می‌دهد
- توکن واریز شده را به کیف پول مقصد منتقل می‌کند
- برای انتقال ERC20 (USDT, USDC) نیاز به **مقداری ETH** برای پرداخت گس دارد

برای پرداخت واقعی گس با توکن‌های ERC20 (مانند Trust Wallet FlexGas) نیاز به:
- زیرساخت Relayer
- یا Account Abstraction (ERC-4337)
- یا Gas Station Network (GSN)

که فراتر از محدوده این ماژول است.

## توکن‌های پشتیبانی شده

| توکن | نوع | آدرس قرارداد |
|------|-----|--------------|
| ETH | Native | - |
| USDT | ERC20 | 0xdAC17F958D2ee523a2206206994597C13D831ec7 |
| USDC | ERC20 | 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 |

## نیازمندی‌ها

- Node.js >= 18.0.0
- ethers.js >= 6.0.0
- متغیرهای محیطی تنظیم شده در `.env`

## متغیرهای محیطی مورد نیاز

```
PRIVATE_KEY=your_private_key_here
DESTINATION_ADDRESS=0xYourDestinationAddress
RPC_URL_PRIMARY=https://your-rpc-url
```
