# 🐧 راهنمای نصب روی سرور اوبنتو لینوکس

این راهنما برای نصب و راه‌اندازی ربات روی سرور اوبنتو (18.04، 20.04، 22.04 یا 24.04) با یوزر غیر root است.

---

## ✅ پیش‌نیازها

- سرور اوبنتو (حداقل 1GB RAM)
- دسترسی SSH به سرور
- اتصال اینترنت پایدار

---

## 🔧 مرحله 1: ایجاد یوزر غیر root (اگر ندارید)

### 1.1 اتصال به سرور با root
```bash
ssh root@your-server-ip
```

### 1.2 ایجاد یوزر جدید
```bash
# ایجاد یوزر با نام ethbot (یا هر نام دلخواه)
adduser ethbot

# اضافه کردن یوزر به گروه sudo
usermod -aG sudo ethbot
```

### 1.3 تست یوزر جدید
```bash
# خروج از root و ورود با یوزر جدید
exit
ssh ethbot@your-server-ip
```

---

## 📦 مرحله 2: نصب Node.js (روش پیشنهادی با NodeSource)

### 2.1 به‌روزرسانی سیستم
```bash
sudo apt update
sudo apt upgrade -y
```

### 2.2 نصب ابزارهای مورد نیاز
```bash
sudo apt install -y curl wget git build-essential
```

### 2.3 نصب Node.js 20.x (پیشنهادی)
```bash
# اضافه کردن مخزن NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

# نصب Node.js و npm
sudo apt install -y nodejs

# تأیید نصب
node --version    # باید 20.x نشان دهد
npm --version     # باید 10.x نشان دهد
```

### روش جایگزین: نصب با NVM (مدیریت نسخه‌های مختلف)
```bash
# نصب NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# فعال‌سازی NVM
source ~/.bashrc

# نصب Node.js 20
nvm install 20
nvm use 20
nvm alias default 20

# تأیید نصب
node --version
npm --version
```

---

## 📥 مرحله 3: آپلود و نصب پروژه

### 3.1 آپلود فایل ZIP به سرور

**روش 1: با SCP از کامپیوتر خودتان**
```bash
# از کامپیوتر محلی اجرا کنید
scp ultra-fast-eth-bot.zip ethbot@your-server-ip:/home/ethbot/
```

**روش 2: با wget (اگر فایل آنلاین است)**
```bash
cd ~
wget https://your-download-link/ultra-fast-eth-bot.zip
```

**روش 3: با SFTP**
```bash
sftp ethbot@your-server-ip
put ultra-fast-eth-bot.zip
exit
```

### 3.2 نصب unzip و استخراج
```bash
# نصب unzip
sudo apt install -y unzip

# استخراج آرشیو
cd ~
unzip ultra-fast-eth-bot.zip

# ورود به پوشه پروژه
cd ultra-fast-eth-bot
```

### 3.3 نصب وابستگی‌های پروژه
```bash
# نصب پکیج‌های npm
npm install

# در صورت بروز خطا، از دستور زیر استفاده کنید:
npm install --legacy-peer-deps
```

---

## ⚙️ مرحله 4: پیکربندی پروژه

### 4.1 ایجاد فایل محیطی
```bash
# کپی نمونه فایل .env
cp .env.example .env

# ویرایش فایل .env
nano .env
```

### 4.2 تنظیمات ضروری در .env
```env
# کلید خصوصی کیف پول (بدون 0x یا با 0x)
PRIVATE_KEY=your_private_key_here

# آدرس مقصد برای انتقال
DESTINATION_ADDRESS=0xYourDestinationAddress

# RPC اتریوم (حداقل یکی الزامی)
RPC_URL_PRIMARY=https://mainnet.infura.io/v3/YOUR_INFURA_KEY
RPC_URL_SECONDARY=https://eth-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY

# تنظیمات تلگرام (اختیاری)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_PASSWORD=your_secure_password

# پورت سرور
PORT=5000
```

**ذخیره و خروج**: `Ctrl + O` سپس `Enter` و بعد `Ctrl + X`

### 4.3 تنظیم دسترسی‌های امنیتی
```bash
# محافظت از فایل .env
chmod 600 .env

# تنظیم مالکیت فایل‌ها
chown -R $USER:$USER ~/ultra-fast-eth-bot
```

---

## 🚀 مرحله 5: اجرای ربات

### 5.1 تست اولیه (Foreground)
```bash
# اجرای مستقیم برای تست
npm start
```

برای توقف: `Ctrl + C`

### 5.2 اجرای پایدار با PM2 (پیشنهادی)

**نصب PM2**
```bash
sudo npm install -g pm2
```

**اجرای ربات با PM2**
```bash
# شروع ربات
pm2 start src/bot.js --name "eth-bot"

# مشاهده وضعیت
pm2 status

# مشاهده لاگ‌ها
pm2 logs eth-bot

# مشاهده لاگ‌های real-time
pm2 logs eth-bot --lines 50
```

**تنظیم راه‌اندازی خودکار**
```bash
# ذخیره لیست برنامه‌ها
pm2 save

# راه‌اندازی خودکار بعد از ریبوت
pm2 startup

# دستور نمایش داده شده را اجرا کنید (مثلاً):
# sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ethbot --hp /home/ethbot
```

**دستورات مدیریتی PM2**
```bash
# توقف ربات
pm2 stop eth-bot

# راه‌اندازی مجدد
pm2 restart eth-bot

# حذف از PM2
pm2 delete eth-bot

# مانیتورینگ
pm2 monit
```

### 5.3 اجرای پایدار با Screen (روش ساده‌تر)

```bash
# نصب screen
sudo apt install -y screen

# ایجاد session جدید
screen -S ethbot

# اجرای ربات
npm start

# جدا شدن از screen (ربات همچنان اجرا می‌شود)
# فشار دهید: Ctrl + A سپس D

# بازگشت به session
screen -r ethbot

# لیست تمام session ها
screen -ls

# بستن session
screen -X -S ethbot quit
```

### 5.4 اجرای پایدار با systemd (روش حرفه‌ای)

**ایجاد فایل service**
```bash
sudo nano /etc/systemd/system/ethbot.service
```

**محتوای فایل service:**
```ini
[Unit]
Description=Ultra-Fast Ethereum Transfer Bot
After=network.target

[Service]
Type=simple
User=ethbot
WorkingDirectory=/home/ethbot/ultra-fast-eth-bot
ExecStart=/usr/bin/node /home/ethbot/ultra-fast-eth-bot/src/bot.js
Restart=always
RestartSec=10
StandardOutput=append:/home/ethbot/ultra-fast-eth-bot/bot.log
StandardError=append:/home/ethbot/ultra-fast-eth-bot/bot.error.log
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

**فعال‌سازی و راه‌اندازی:**
```bash
# reload systemd
sudo systemctl daemon-reload

# فعال کردن service
sudo systemctl enable ethbot

# شروع service
sudo systemctl start ethbot

# مشاهده وضعیت
sudo systemctl status ethbot

# مشاهده لاگ‌ها
sudo journalctl -u ethbot -f

# توقف service
sudo systemctl stop ethbot

# راه‌اندازی مجدد
sudo systemctl restart ethbot
```

---

## 🔥 مرحله 6: تنظیمات فایروال (اختیاری)

اگر می‌خواهید پورت 5000 از خارج قابل دسترسی باشد:

```bash
# فعال کردن UFW
sudo ufw enable

# اجازه دسترسی SSH (حتماً قبل از enable!)
sudo ufw allow 22/tcp

# اجازه دسترسی به پورت ربات
sudo ufw allow 5000/tcp

# مشاهده وضعیت
sudo ufw status
```

---

## 📊 مرحله 7: مانیتورینگ و نگهداری

### 7.1 بررسی وضعیت ربات
```bash
# با PM2
pm2 status
pm2 logs eth-bot --lines 100

# با systemd
sudo systemctl status ethbot
sudo journalctl -u ethbot -n 100

# بررسی health endpoint
curl http://localhost:5000/health
```

### 7.2 مشاهده استفاده از منابع
```bash
# استفاده CPU و RAM
pm2 monit

# یا با htop
sudo apt install htop
htop
```

### 7.3 چرخش لاگ‌ها (Log Rotation)
```bash
# ایجاد فایل logrotate
sudo nano /etc/logrotate.d/ethbot
```

محتوا:
```
/home/ethbot/ultra-fast-eth-bot/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0640 ethbot ethbot
}
```

---

## 🔄 مرحله 8: به‌روزرسانی ربات

```bash
# توقف ربات
pm2 stop eth-bot  # یا sudo systemctl stop ethbot

# پشتیبان از پیکربندی
cp .env .env.backup
cp -r data data.backup

# دانلود نسخه جدید
cd ~
wget https://your-new-version.zip -O new-bot.zip
unzip new-bot.zip -d new-bot

# کپی فایل‌های جدید
cd new-bot/ultra-fast-eth-bot
cp -r src ~/ultra-fast-eth-bot/
cp -r tests ~/ultra-fast-eth-bot/
cp package.json ~/ultra-fast-eth-bot/

# بازگشت پیکربندی
cd ~/ultra-fast-eth-bot
cp .env.backup .env

# نصب وابستگی‌های جدید
npm install

# راه‌اندازی مجدد
pm2 restart eth-bot  # یا sudo systemctl restart ethbot
```

---

## 🛡️ نکات امنیتی مهم

### 1. امنیت کلید خصوصی
```bash
# فایل .env باید فقط توسط مالک قابل خواندن باشد
chmod 600 .env
ls -la .env  # باید -rw------- نشان دهد
```

### 2. به‌روزرسانی سیستم
```bash
# به‌روزرسانی منظم
sudo apt update && sudo apt upgrade -y

# پاکسازی
sudo apt autoremove -y
sudo apt autoclean
```

### 3. محدود کردن دسترسی SSH
```bash
# ویرایش تنظیمات SSH
sudo nano /etc/ssh/sshd_config
```

تنظیمات پیشنهادی:
```
PermitRootLogin no
PasswordAuthentication no  # فقط با SSH key
AllowUsers ethbot
```

```bash
# راه‌اندازی مجدد SSH
sudo systemctl restart sshd
```

---

## 🐛 عیب‌یابی مشکلات رایج

### مشکل 1: خطای Permission Denied
```bash
# بررسی مالکیت فایل‌ها
ls -la ~/ultra-fast-eth-bot

# تنظیم مالکیت صحیح
chown -R $USER:$USER ~/ultra-fast-eth-bot
```

### مشکل 2: ربات متوقف می‌شود
```bash
# بررسی لاگ‌ها
pm2 logs eth-bot --err

# افزایش حافظه Node.js
pm2 delete eth-bot
pm2 start src/bot.js --name "eth-bot" --node-args="--max-old-space-size=2048"
```

### مشکل 3: خطای Port Already in Use
```bash
# یافتن process استفاده‌کننده از پورت
sudo lsof -i :5000

# یا
sudo netstat -tulpn | grep 5000

# کشتن process
sudo kill -9 <PID>
```

### مشکل 4: خطای RPC Connection
```bash
# تست اتصال RPC
curl -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  https://mainnet.infura.io/v3/YOUR_KEY

# استفاده از RPC دیگر در .env
```

---

## 📋 چک‌لیست نصب

- [ ] یوزر غیر root ایجاد شد
- [ ] Node.js 18+ نصب شد
- [ ] پروژه استخراج شد
- [ ] فایل .env پیکربندی شد
- [ ] دسترسی‌های فایل تنظیم شد (chmod 600 .env)
- [ ] وابستگی‌ها نصب شدند (npm install)
- [ ] ربات تست شد (npm start)
- [ ] PM2 یا systemd پیکربندی شد
- [ ] راه‌اندازی خودکار فعال شد
- [ ] فایروال تنظیم شد (اختیاری)
- [ ] مانیتورینگ راه‌اندازی شد

---

## 📞 منابع و کمک

### دستورات سریع مرجع

```bash
# نصب سریع (یک‌خطی)
cd ~ && \
unzip ultra-fast-eth-bot.zip && \
cd ultra-fast-eth-bot && \
npm install && \
cp .env.example .env

# اجرا با PM2 (سریع)
sudo npm install -g pm2 && \
pm2 start src/bot.js --name "eth-bot" && \
pm2 save && \
pm2 startup

# مشاهده وضعیت (سریع)
pm2 status && pm2 logs eth-bot --lines 20
```

### لینک‌های مفید
- Node.js: https://nodejs.org/
- PM2: https://pm2.keymetrics.io/
- Ubuntu Server Guide: https://ubuntu.com/server/docs

---

**نسخه مستند**: 1.0  
**سازگار با**: Ubuntu 18.04, 20.04, 22.04, 24.04  
**آخرین به‌روزرسانی**: نوامبر 2025

---

## ✅ حالا ربات شما آماده اجراست!

برای کمک بیشتر، README.md پروژه را مطالعه کنید.
