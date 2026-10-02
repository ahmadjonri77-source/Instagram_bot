# insta-bot

Instagram, TikTok, Pinterest, Facebook va YouTube Shorts havolalaridan video/rasmlarni yuklab beradigan Telegram bot.

## Talablar

- Node.js, Redis
- `yt-dlp`, `gallery-dl`, `ffmpeg` (`ffprobe` bilan) — PATH'da bo'lishi kerak

## `.env`

```
BOT_TOKEN=...          # majburiy
REDIS_HOST=127.0.0.1   # ixtiyoriy
REDIS_PORT=6379        # ixtiyoriy
COOKIES_FILE=...       # ixtiyoriy, Netscape formatidagi cookie fayli
YOUTUBE_COOKIES_FILE=... # ixtiyoriy, YouTube uchun alohida akkaunt cookie'lari (server IP bloklanganda)
ADMIN_ID=...           # ixtiyoriy, xatolar shu odamga yuboriladi
CHANNEL_ID=...         # ixtiyoriy, yuklanganlar shu kanalga ham tashlanadi
```

## Ishga tushirish

```bash
npm install
npm run start:dev   # lokal
npm test
```

Bitta token bilan faqat bitta bot ishlashi mumkin — server ishlab turganda lokal ishga tushirish `409 Conflict` beradi.

## Serverni yangilash (pm2)

```bash
cd ~/insta-bot
git pull
npm install
npm run build && pm2 restart insta-bot
sudo yt-dlp -U
```

`pm2 restart` faqat build muvaffaqiyatli tugagandan keyin — aks holda `dist/` bo'sh qoladi va bot yiqiladi.
