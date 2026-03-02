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

// ────────────────────────────────────────────────
// MODELS
// ────────────────────────────────────────────────

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

// ────────────────────────────────────────────────
// PAYOS
// ────────────────────────────────────────────────
const payos = new PayOS({
    clientId: process.env.PAYOS_CLIENT_ID,
    apiKey: process.env.PAYOS_API_KEY,
    checksumKey: process.env.PAYOS_CHECKSUM_KEY,
});

// ────────────────────────────────────────────────
// BOT + SESSION
// ────────────────────────────────────────────────
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
bot.use(session());

// ADMIN ID của bạn
const ADMIN_ID = '5589888565';
const isAdmin = (ctx) => ctx.from.id.toString() === ADMIN_ID;

// ────────────────────────────────────────────────
// Commands cơ bản
// ────────────────────────────────────────────────

bot.start((ctx) => {
    ctx.reply(
        'Chào mừng bạn đến shop! 👋\n\n' +
        'Dùng /products để xem sản phẩm và tài khoản premium.'
    );
});

bot.command('products', async(ctx) => {
    try {
        const products = await Product.find();
        const accounts = await Account.find({ status: 'available' });

        if (products.length === 0 && accounts.length === 0) {
            return ctx.reply('Hiện tại chưa có sản phẩm hoặc tài khoản nào.');
        }

        let message = '🛍️ DANH SÁCH SẢN PHẨM & TÀI KHOẢN PREMIUM\n\n';

        if (products.length > 0) {
            message += '📦 Sản phẩm:\n';
            products.forEach(p => {
                message += `• ${p.name} — ${p.price.toLocaleString('vi-VN')} ₫\n`;
            });
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

// ────────────────────────────────────────────────
// XỬ LÝ NÚT MUA - ĐÃ SỬA ĐỂ LẤY TRỰC TIẾP TỪ ROOT RESPONSE
// ────────────────────────────────────────────────

bot.action(/buy_acc_(.+)/, async(ctx) => {
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
            description: `Mua ${account.name} ${account.price}đ`.slice(0, 25), // Giới hạn 25 ký tự
            items: [{
                name: account.name,
                quantity: 1,
                price: account.price
            }],
            returnUrl: `${process.env.WEBHOOK_URL}/success?orderId=${order._id}`,
            cancelUrl: `${process.env.WEBHOOK_URL}/cancel?orderId=${order._id}`,
        });

        console.log('[PAYOS RESPONSE]', JSON.stringify(paymentLink, null, 2));

        // Kiểm tra và lấy dữ liệu TRỰC TIẾP từ root object (không có .data)
        if (!paymentLink) {
            throw new Error('PayOS trả về null/undefined');
        }
        if (!paymentLink.checkoutUrl) {
            throw new Error('PayOS trả về không có checkoutUrl');
        }
        if (!paymentLink.paymentLinkId) {
            throw new Error('PayOS trả về không có paymentLinkId');
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
        await ctx.reply(
            '⚠️ **Lỗi tạo link thanh toán**\n' +
            'Vui lòng thử lại hoặc liên hệ admin để kiểm tra!'
        );
        await ctx.answerCbQuery('Lỗi hệ thống', { show_alert: true });
    }
});

// ────────────────────────────────────────────────
// ADMIN: Gửi file TXT → Chọn loại bằng button
// ────────────────────────────────────────────────

bot.on('document', async(ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('Chỉ admin mới upload được file!');
    }

    const file = ctx.message.document;
    if (!file.file_name.toLowerCase().endsWith('.txt')) {
        return ctx.reply('Chỉ chấp nhận file .txt!');
    }

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
            [Markup.button.callback('Tất cả (toàn bộ file)', 'update_type_all')],
            [Markup.button.callback('Hủy', 'update_cancel')]
        ]);

        await ctx.reply(
            `Đã nhận file: ${file.file_name}\nKích thước: ${file.file_size} bytes\n\nChọn loại tài khoản để cập nhật/thêm từ file này:`,
            keyboard
        );
    } catch (err) {
        console.error('Lỗi tải/đọc file:', err);
        ctx.reply('Có lỗi khi xử lý file. Thử lại nhé!');
    }
});

// Xử lý button chọn loại (giữ nguyên, chỉ sửa cú pháp optional chaining nếu có)
bot.action(/update_type_(.*)/, async(ctx) => {
    await ctx.answerCbQuery();

    if (!isAdmin(ctx)) {
        return ctx.answerCbQuery('Không có quyền!', { show_alert: true });
    }

    const selectedType = ctx.match[1];

    if (!ctx.session || !ctx.session.pendingFileContent) {
        return ctx.editMessageText('Phiên file đã hết hạn hoặc không tồn tại. Gửi file lại nhé!');
    }

    const content = ctx.session.pendingFileContent;

    try {
        const lines = content.trim().split('\n').filter(line => line.trim() !== '');
        let added = 0;
        let updated = 0;
        let processed = 0;
        let errors = [];

        for (const line of lines) {
            const parts = line.split('|').map(p => p.trim());
            if (parts.length < 6) {
                errors.push(`Dòng lỗi định dạng: ${line}`);
                continue;
            }

            const [type, name, priceStr, duration, email, password, ...descParts] = parts;
            const description = descParts.join('|');
            const price = parseInt(priceStr, 10);

            if (isNaN(price) || !email || !password) {
                errors.push(`Dòng lỗi giá trị: ${line}`);
                continue;
            }

            if (selectedType !== 'all' && type !== selectedType) continue;

            processed++;

            let account = await Account.findOne({ email });

            if (account) {
                account.type = type;
                account.name = name;
                account.price = price;
                account.duration = duration;
                account.password = password;
                account.description = description;
                account.status = 'available';
                await account.save();
                updated++;
            } else {
                await Account.create({
                    type,
                    name,
                    price,
                    duration,
                    email,
                    password,
                    description,
                    status: 'available'
                });
                added++;
            }
        }

        let msg = `✅ Xử lý xong cho loại: ${selectedType === 'all' ? 'TẤT CẢ' : selectedType}\n\n` +
            `Thêm mới: ${added}\n` +
            `Cập nhật: ${updated}\n` +
            `Dòng được xử lý: ${processed}/${lines.length}\n`;

        if (errors.length > 0) {
            msg += `\nLỗi:\n${errors.join('\n')}`;
        }

        await ctx.editMessageText(msg);
        delete ctx.session.pendingFileContent;
    } catch (err) {
        console.error('Lỗi xử lý cập nhật tài khoản:', err);
        await ctx.editMessageText('Có lỗi khi xử lý file. Kiểm tra console để xem chi tiết.');
    }
});

bot.action('update_cancel', async(ctx) => {
    await ctx.answerCbQuery();
    if (ctx.session && ctx.session.pendingFileContent) {
        delete ctx.session.pendingFileContent;
    }
    await ctx.editMessageText('Đã hủy cập nhật từ file.');
});

// ────────────────────────────────────────────────
// WEBHOOK PAYOS + SERVER
// ────────────────────────────────────────────────
const app = express();
app.use(bodyParser.json());

app.post('/payos-webhook', async(req, res) => {
    try {
        const webhookData = await payos.webhooks.verify(req.body);

        if (webhookData.success) {
            const { paymentLinkId, orderCode, amount, status } = webhookData.data;

            console.log('[WEBHOOK] Nhận thanh toán thành công:', webhookData.data);

            // Tìm đơn hàng theo paymentLinkId
            const order = await Order.findOne({ paymentLinkId });

            if (!order) {
                console.error('[WEBHOOK] Không tìm thấy order với paymentLinkId:', paymentLinkId);
                return res.status(200).send('OK'); // vẫn trả OK cho PayOS
            }

            if (order.status === 'PAID') {
                console.log('[WEBHOOK] Đơn hàng đã PAID trước đó:', orderCode);
                return res.status(200).send('OK');
            }

            // Cập nhật trạng thái đơn hàng
            order.status = 'PAID';
            await order.save();

            // Nếu là tài khoản premium (type === 'account')
            if (order.type === 'account') {
                const account = await Account.findById(order.productId);

                if (account) {
                    // Gửi thông tin tài khoản cho user
                    const msg = `🎉 **THANH TOÁN THÀNH CÔNG!**\n\n` +
                        `Sản phẩm: ${account.name}\n` +
                        `Thời hạn: ${account.duration}\n` +
                        `Email: ${account.email}\n` +
                        `Mật khẩu: ${account.password}\n\n` +
                        `Hướng dẫn:\n` +
                        `• Đăng nhập ngay để sử dụng\n` +
                        `• Nên đổi mật khẩu sau khi nhận\n` +
                        `• Bảo hành: Liên hệ admin nếu tài khoản lỗi\n\n` +
                        `Cảm ơn bạn đã mua hàng! ❤️\n` +
                        `(Mã đơn: ${orderCode})`;

                    await bot.telegram.sendMessage(order.userId, msg);

                    // Đánh dấu tài khoản đã bán
                    account.status = 'sold';
                    account.soldTo = order.userId;
                    await account.save();

                    console.log(`[WEBHOOK] Đã gửi tài khoản cho user ${order.userId}: ${account.email}`);
                } else {
                    console.error('[WEBHOOK] Không tìm thấy tài khoản với ID:', order.productId);
                }
            } else {
                // Nếu là sản phẩm khác (nếu có sau này)
                await bot.telegram.sendMessage(order.userId, `Đơn hàng ${orderCode} đã thanh toán thành công! Vui lòng chờ xử lý.`);
            }
        }

        res.status(200).send('OK');
    } catch (err) {
        console.error('Webhook error:', err.message || err);
        res.status(400).send('Invalid');
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
