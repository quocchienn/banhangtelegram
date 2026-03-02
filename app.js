require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const mongoose = require('mongoose');
const { PayOS } = require('@payos/node');
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

globalThis.fetch = fetch;

/* ================== MONGODB ================== */

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Đã kết nối MongoDB Atlas'))
  .catch(err => console.error('❌ Lỗi MongoDB:', err));

/* ================== MODELS ================== */

const Product = mongoose.model('Product', new mongoose.Schema({
  name: String,
  price: Number,
  description: String,
}));

const Account = mongoose.model('Account', new mongoose.Schema({
  type: String,
  name: String,
  price: Number,
  duration: String,
  email: String,
  password: String,
  status: { type: String, default: 'available' },
  soldTo: String,
  description: String,
  createdAt: { type: Date, default: Date.now }
}));

const Order = mongoose.model('Order', new mongoose.Schema({
  userId: String,
  productId: String,
  amount: Number,
  status: { type: String, default: 'PENDING' },
  paymentLinkId: String,
  type: String,
  createdAt: { type: Date, default: Date.now }
}));

/* ================== PAYOS ================== */

const payos = new PayOS({
  clientId: process.env.PAYOS_CLIENT_ID,
  apiKey: process.env.PAYOS_API_KEY,
  checksumKey: process.env.PAYOS_CHECKSUM_KEY,
});

/* ================== BOT ================== */

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
bot.use(session());

bot.start(ctx => {
  ctx.reply('Chào mừng bạn 👋\nDùng /products để xem sản phẩm.');
});

/* ================== EXPRESS ================== */

const app = express();

/* ⚠️ QUAN TRỌNG: dùng JSON cho route thường */
app.use(bodyParser.json());

/* ================== WEBHOOK PAYOS (RAW BODY) ================== */
/* Đây là phần quan trọng nhất */

app.post(
  '/payos-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const webhookData = await payos.webhooks.verify(req.body);

      console.log("🔥 WEBHOOK HIT 🔥");
      console.log(webhookData);

      if (webhookData.success) {
        const { paymentLinkId, orderCode } = webhookData.data;

        const order = await Order.findOne({ paymentLinkId });
        if (!order) {
          console.log("Không tìm thấy order");
          return res.status(200).send("OK");
        }

        if (order.status === 'PAID') {
          return res.status(200).send("OK");
        }

        order.status = 'PAID';
        await order.save();

        const account = await Account.findById(order.productId);
        if (account && account.status === 'available') {

          await bot.telegram.sendMessage(
            order.userId,
            `🎉 THANH TOÁN THÀNH CÔNG!\n\nEmail: ${account.email}\nMật khẩu: ${account.password}\n\n(Mã đơn: ${orderCode})`
          );

          account.status = 'sold';
          account.soldTo = order.userId;
          await account.save();

          console.log("Đã gửi tài khoản cho user:", order.userId);
        }
      }

      res.status(200).send("OK");

    } catch (err) {
      console.error("❌ Webhook verify lỗi:", err);
      res.status(400).send("Invalid");
    }
  }
);

/* ================== SUCCESS PAGE (BẢO HIỂM) ================== */

app.get('/success', async (req, res) => {
  const { orderId } = req.query;
  res.send('<h1>Thanh toán thành công!</h1>');
});

app.get('/cancel', (req, res) => {
  res.send('<h1>Thanh toán bị hủy</h1>');
});

/* ================== SERVER ================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server chạy port ${PORT}`);
});

/* ================== BOT LAUNCH FIX 409 ================== */

(async () => {
  try {
    await bot.telegram.deleteWebhook(); // dọn session cũ
    await bot.launch();
    console.log('🚀 Bot Telegram đã chạy');
  } catch (err) {
    console.error('Lỗi khởi động bot:', err);
  }
})();

/* ================== CONFIRM WEBHOOK ================== */

payos.webhooks.confirm(
  "https://banhangtelegram.onrender.com/payos-webhook"
)
.then(() => console.log('Webhook confirmed'))
.catch(err => console.error('Lỗi confirm:', err));
