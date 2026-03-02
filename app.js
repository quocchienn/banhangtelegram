require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const { Telegraf, Markup, session } = require('telegraf');
const { PayOS } = require('@payos/node');
const fetch = require('node-fetch');

globalThis.fetch = fetch;

/* ===================== MONGODB ===================== */

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

/* ===================== MODELS ===================== */

const Account = mongoose.model('Account', new mongoose.Schema({
  name: String,
  price: Number,
  duration: String,
  email: String,
  password: String,
  status: { type: String, default: 'available' },
  soldTo: String,
  createdAt: { type: Date, default: Date.now }
}));

const Order = mongoose.model('Order', new mongoose.Schema({
  userId: String,
  productId: String,
  amount: Number,
  status: { type: String, default: 'PENDING' },
  paymentLinkId: String,
  createdAt: { type: Date, default: Date.now }
}));

/* ===================== PAYOS ===================== */

const payos = new PayOS({
  clientId: process.env.PAYOS_CLIENT_ID,
  apiKey: process.env.PAYOS_API_KEY,
  checksumKey: process.env.PAYOS_CHECKSUM_KEY,
});

/* ===================== BOT ===================== */

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
bot.use(session());

bot.start(ctx => {
  ctx.reply('Chào mừng bạn 👋\nDùng /products để xem sản phẩm.');
});

/* ====== LỆNH /products ====== */

bot.command('products', async (ctx) => {
  try {
    const accounts = await Account.find({ status: 'available' });

    if (!accounts.length) {
      return ctx.reply('❌ Hiện tại hết hàng.');
    }

    for (const acc of accounts) {
      await ctx.reply(
        `🔑 ${acc.name}\n💰 Giá: ${acc.price} đ\n⏳ Thời hạn: ${acc.duration}`,
        Markup.inlineKeyboard([
          Markup.button.callback(
            `Mua ${acc.name}`,
            `buy_${acc._id}`
          )
        ])
      );
    }

  } catch (err) {
    console.error(err);
    ctx.reply('Lỗi tải sản phẩm.');
  }
});

/* ====== NÚT MUA ====== */

bot.action(/buy_(.+)/, async (ctx) => {
  try {
    const productId = ctx.match[1];
    const account = await Account.findById(productId);

    if (!account || account.status !== 'available') {
      return ctx.reply('❌ Sản phẩm không khả dụng.');
    }

    const orderCode = Date.now();

    const paymentLink = await payos.createPaymentLink({
      orderCode,
      amount: account.price,
      description: account.name,
      returnUrl: "https://banhangtelegram.onrender.com/success",
      cancelUrl: "https://banhangtelegram.onrender.com/cancel"
    });

    await Order.create({
      userId: ctx.from.id,
      productId: account._id,
      amount: account.price,
      paymentLinkId: paymentLink.paymentLinkId
    });

    await ctx.reply(
      `✅ Đơn hàng đã tạo thành công!\n\nThanh toán tại:\n${paymentLink.checkoutUrl}`
    );

  } catch (err) {
    console.error(err);
    ctx.reply('❌ Lỗi tạo đơn hàng.');
  }
});

/* ===================== EXPRESS ===================== */

const app = express();

/* Dùng JSON cho route thường */
app.use(bodyParser.json());

/* ====== WEBHOOK PAYOS (RAW BODY) ====== */

app.post(
  '/payos-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const webhookData = await payos.webhooks.verify(req.body);

      console.log("🔥 WEBHOOK HIT 🔥");
      console.log(webhookData);

      if (webhookData.success) {
        const { paymentLinkId } = webhookData.data;

        const order = await Order.findOne({ paymentLinkId });
        if (!order) return res.status(200).send("OK");

        if (order.status === 'PAID')
          return res.status(200).send("OK");

        order.status = 'PAID';
        await order.save();

        const account = await Account.findById(order.productId);

        if (account && account.status === 'available') {
          await bot.telegram.sendMessage(
            order.userId,
            `🎉 THANH TOÁN THÀNH CÔNG!\n\nEmail: ${account.email}\nMật khẩu: ${account.password}`
          );

          account.status = 'sold';
          account.soldTo = order.userId;
          await account.save();

          console.log("Đã gửi tài khoản cho user:", order.userId);
        }
      }

      res.status(200).send("OK");

    } catch (err) {
      console.error("❌ Webhook lỗi:", err);
      res.status(400).send("Invalid");
    }
  }
);

/* ====== SUCCESS / CANCEL ====== */

app.get('/success', (req, res) => {
  res.send('<h1>Thanh toán thành công!</h1>');
});

app.get('/cancel', (req, res) => {
  res.send('<h1>Thanh toán bị hủy</h1>');
});

/* ===================== SERVER ===================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running port ${PORT}`);
});

/* ===================== BOT LAUNCH FIX 409 ===================== */

(async () => {
  try {
    await bot.telegram.deleteWebhook();
    await bot.launch();
    console.log('🚀 Bot running');
  } catch (err) {
    console.error('Bot start error:', err);
  }
})();

/* ====== CONFIRM WEBHOOK ====== */

payos.webhooks.confirm(
  "https://banhangtelegram.onrender.com/payos-webhook"
)
.then(() => console.log('Webhook confirmed'))
.catch(err => console.error('Confirm lỗi:', err));
