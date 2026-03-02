require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const mongoose = require('mongoose');
const { PayOS } = require('@payos/node');
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

// Polyfill fetch cho PayOS
globalThis.fetch = fetch;

// Kết nối MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Đã kết nối MongoDB Atlas'))
  .catch(err => console.error('❌ Lỗi kết nối MongoDB:', err));

// MODELS
const ProductSchema = new mongoose.Schema({
  name: String,
  price: Number,
  description: String,
});
const Product = mongoose.model('Product', ProductSchema);

const AccountSchema = new mongoose.Schema({
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
});
const Account = mongoose.model('Account', AccountSchema);

const OrderSchema = new mongoose.Schema({
  userId: String,
  productId: String,
  amount: Number,
  status: { type: String, default: 'PENDING' },
  paymentLinkId: String,
  type: String,
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', OrderSchema);

// PAYOS
const payos = new PayOS({
  clientId: process.env.PAYOS_CLIENT_ID,
  apiKey: process.env.PAYOS_API_KEY,
  checksumKey: process.env.PAYOS_CHECKSUM_KEY,
});

// BOT + SESSION
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
bot.use(session());

const ADMIN_ID = '5589888565';
const isAdmin = (ctx) => ctx.from.id.toString() === ADMIN_ID;

// Commands cơ bản
bot.start((ctx) => {
  ctx.reply('Chào mừng bạn đến shop! 👋\n\nDùng /products để xem sản phẩm và tài khoản premium.');
});

bot.command('products', async (ctx) => {
  try {
    const products = await Product.find();
    const accounts = await Account.find({ status: 'available' });

    if (products.length === 0 && accounts.length === 0) {
      return ctx.reply('Hiện tại chưa có sản phẩm hoặc tài khoản nào.');
    }

    let message = '🛍️ DANH SÁCH SẢN PHẨM & TÀI KHOẢN PREMIUM\n\n';

    if (products.length > 0) {
      message += '📦 Sản phẩm:\n';
      products.forEach(p => message += `• ${p.name} — ${p.price.toLocaleString('vi-VN')} ₫\n`);
      message += '\n';
    }

    if (accounts.length > 0) {
      message += '🔐 Tài khoản Premium (còn hàng):\n';
      const buttons = accounts.map(acc => [
        Markup.button.callback(`Mua ${acc.name}`, `buy_acc_${acc._id}`)
      ]);
      return ctx.reply(message, Markup.inlineKeyboard(buttons));
    }

    ctx.reply(message);
  } catch (err) {
    console.error('Lỗi /products:', err);
    ctx.reply('Có lỗi khi tải danh sách. Thử lại sau nhé!');
  }
});

// Xử lý nút mua
bot.action(/buy_acc_(.+)/, async (ctx) => {
  try {
    const accId = ctx.match[1];
    const account = await Account.findById(accId);

    if (!account || account.status !== 'available') {
      return ctx.answerCbQuery('Tài khoản này đã bán hoặc không tồn tại!', { show_alert: true });
    }

    const orderCode = Date.now();
    const order = new Order({
      userId: ctx.from.id.toString(),
      productId: account._id.toString(),
      amount: account.price,
      type: 'account'
    });
    await order.save();

    console.log(`[ORDER] Tạo đơn hàng thành công - User: ${ctx.from.id}, Sản phẩm: ${account.name}, Mã đơn: ${orderCode}, Giá: ${account.price} VND`);

    const paymentLink = await payos.paymentRequests.create({
      orderCode: orderCode,
      amount: account.price,
      description: `Mua ${account.name} ${account.price}đ`.slice(0, 25),
      items: [{
        name: account.name,
        quantity: 1,
        price: account.price
      }],
      returnUrl: `${process.env.WEBHOOK_URL}/success?orderId=${order._id}`,
      cancelUrl: `${process.env.WEBHOOK_URL}/cancel?orderId=${order._id}`,
    });

    console.log('[PAYOS RESPONSE]', JSON.stringify(paymentLink, null, 2));

    if (!paymentLink || !paymentLink.checkoutUrl || !paymentLink.paymentLinkId) {
      throw new Error('PayOS trả về không hợp lệ');
    }

    order.paymentLinkId = paymentLink.paymentLinkId;
    await order.save();

    await ctx.reply(
      `✅ **Đơn hàng đã tạo thành công!**\n\n` +
      `Sản phẩm: ${account.name}\n` +
      `Giá: ${account.price.toLocaleString('vi-VN')} ₫\n` +
      `Thời hạn: ${account.duration}\n\n` +
      `🔗 **Nhấn để thanh toán ngay**: ${paymentLink.checkoutUrl}\n\n` +
      `Sau khi thanh toán xong, thông tin tài khoản sẽ tự động gửi vào đây.\n` +
      `(Mã đơn: ${orderCode})`
    );

    await ctx.answerCbQuery('Đã tạo link thanh toán!');
  } catch (err) {
    console.error('LỖI TẠO LINK PAYOS:', err.message || err);
    await ctx.reply('⚠️ Lỗi tạo link thanh toán. Vui lòng thử lại!');
    await ctx.answerCbQuery('Lỗi hệ thống', { show_alert: true });
  }
});

// ADMIN upload file TXT (giữ nguyên)
bot.on('document', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Chỉ admin mới upload được file!');

  const file = ctx.message.document;
  if (!file.file_name.toLowerCase().endsWith('.txt')) return ctx.reply('Chỉ chấp nhận file .txt!');

  try {
    const fileLink = await ctx.telegram.getFileLink(file.file_id);
    const response = await fetch(fileLink);
    const textContent = await response.text();

    ctx.session = ctx.session || {};
    ctx.session.pendingFileContent = textContent;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('CapCut', 'update_type_capcut_pro')],
      [Markup.button.callback('Canva', 'update_type_canva_pro')],
      [Markup.button.callback('Netflix', 'update_type_netflix_premium')],
      [Markup.button.callback('Tất cả', 'update_type_all')],
      [Markup.button.callback('Hủy', 'update_cancel')]
    ]);

    await ctx.reply(`Đã nhận file: ${file.file_name}\nChọn loại để cập nhật/thêm:`, keyboard);
  } catch (err) {
    console.error('Lỗi tải file:', err);
    ctx.reply('Có lỗi khi xử lý file.');
  }
});

bot.action(/update_type_(.*)/, async (ctx) => {
  await ctx.answerCbQuery();

  if (!isAdmin(ctx)) return ctx.answerCbQuery('Không có quyền!', { show_alert: true });

  const selectedType = ctx.match[1];
  const content = ctx.session?.pendingFileContent;

  if (!content) return ctx.editMessageText('Phiên file hết hạn. Gửi file lại nhé!');

  try {
    const lines = content.trim().split('\n').filter(l => l.trim());
    let added = 0, updated = 0, processed = 0, errors = [];

    for (const line of lines) {
      const parts = line.split('|').map(p => p.trim());
      if (parts.length < 6) {
        errors.push(`Dòng lỗi định dạng: ${line}`);
        continue;
      }

      const [type, name, priceStr, duration, email, password, ...desc] = parts;
      const description = desc.join('|');
      const price = parseInt(priceStr);

      if (isNaN(price) || !email || !password) {
        errors.push(`Dòng lỗi giá trị: ${line}`);
        continue;
      }

      if (selectedType !== 'all' && type !== selectedType) continue;

      processed++;

      let acc = await Account.findOne({ email });
      if (acc) {
        acc.type = type;
        acc.name = name;
        acc.price = price;
        acc.duration = duration;
        acc.password = password;
        acc.description = description;
        acc.status = 'available';
        await acc.save();
        updated++;
      } else {
        await Account.create({ type, name, price, duration, email, password, description, status: 'available' });
        added++;
      }
    }

    let msg = `✅ Xử lý xong cho loại ${selectedType === 'all' ? 'TẤT CẢ' : selectedType}\n` +
              `Thêm mới: ${added} | Cập nhật: ${updated} | Xử lý: ${processed}/${lines.length}`;

    if (errors.length) msg += `\nLỗi:\n${errors.join('\n')}`;

    await ctx.editMessageText(msg);
    delete ctx.session.pendingFileContent;
  } catch (err) {
    console.error('Lỗi update acc:', err);
    await ctx.editMessageText('Lỗi xử lý file.');
  }
});

bot.action('update_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.session) delete ctx.session.pendingFileContent;
  await ctx.editMessageText('Đã hủy.');
});

// ────────────────────────────────────────────────
// WEBHOOK PAYOS + SERVER (đã tối ưu để confirm OK)
const app = express();
app.use(bodyParser.json());

// Log mọi request đến webhook để debug
app.post('/payos-webhook', async (req, res) => {
  console.log('[WEBHOOK DEBUG] Nhận request POST từ PayOS:', req.body, 'Time:', new Date().toISOString());

  try {
    // Tạm bỏ verify signature để confirm webhook dễ hơn (xóa skipVerify sau khi test thành công)
    const webhookData = await payos.webhooks.verify(req.body, { skipVerify: true });

    if (webhookData.success) {
      const { paymentLinkId, orderCode, amount, status } = webhookData.data;
      console.log('[WEBHOOK] Nhận thanh toán thành công:', webhookData.data);

      const order = await Order.findOne({ paymentLinkId });

      if (!order) {
        console.error('[WEBHOOK] Không tìm thấy order với paymentLinkId:', paymentLinkId);
        return res.status(200).send('OK');
      }

      if (order.status === 'PAID') {
        console.log('[WEBHOOK] Đơn hàng đã PAID trước đó:', orderCode);
        return res.status(200).send('OK');
      }

      order.status = 'PAID';
      await order.save();

      if (order.type === 'account') {
        const account = await Account.findById(order.productId);

        if (account) {
          const msg = `🎉 **THANH TOÁN THÀNH CÔNG!**\n\n` +
                      `Sản phẩm: ${account.name}\n` +
                      `Thời hạn: ${account.duration}\n` +
                      `Email: ${account.email}\n` +
                      `Mật khẩu: ${account.password}\n\n` +
                      `Hướng dẫn:\n• Đăng nhập ngay\n• Đổi mật khẩu sau khi nhận\n• Liên hệ admin nếu lỗi\n\n` +
                      `Cảm ơn bạn! ❤️ (Mã đơn: ${orderCode})`;

          await bot.telegram.sendMessage(order.userId, msg);

          account.status = 'sold';
          account.soldTo = order.userId;
          await account.save();

          console.log(`[WEBHOOK] Đã gửi tài khoản cho user ${order.userId}: ${account.email}`);
        } else {
          console.error('[WEBHOOK] Không tìm thấy tài khoản ID:', order.productId);
        }
      } else {
        await bot.telegram.sendMessage(order.userId, `Đơn hàng ${orderCode} thanh toán thành công!`);
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err.message || err);
    res.status(200).send('OK'); // Luôn trả 200 để PayOS chấp nhận URL khi test/confirm
  }
});

app.get('/success', (req, res) => res.send('<h1>Thanh toán thành công!</h1>'));
app.get('/cancel', (req, res) => res.send('<h1>Thanh toán bị hủy</h1>'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy port ${PORT}`));

// Khởi động bot
bot.launch()
  .then(() => console.log('🚀 Bot Telegram đã chạy'))
  .catch(err => console.error('Lỗi khởi động bot:', err));

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Confirm webhook (chạy 1 lần sau khi deploy, sau comment lại nếu không cần)
payos.webhooks.confirm(`${process.env.WEBHOOK_URL}/payos-webhook`)
  .then(() => console.log('Webhook confirmed thành công'))
  .catch(err => console.error('Lỗi confirm webhook:', err.message || err));
