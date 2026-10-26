const express = require('express');
const db = require('../database');
const authMiddleware = require('../middleware/authMiddleware');
const { queryTradeInfo } = require('../utils/ecpay');
const { SHIPPING_METHODS, calculateShipping } = require('../utils/shipping');
const { applyCoupon, CouponError } = require('../utils/coupon');
const {
  serializeOrder,
  findOrderById,
  findOrderForUser,
  listOrdersForUser,
  getOrderItems,
  getOrderItemSummaries,
  getCheckoutItems,
  findInsufficientItems,
  createOrderFromCart,
  InsufficientStockError
} = require('../services/orderService');
const { isTradePaid, markOrderPaid } = require('../services/paymentService');
const { isNonEmptyString, isValidEmail, parseStrictPagination } = require('../utils/validators');

const ORDER_STATUSES = ['pending', 'paid', 'failed'];
const MAX_ORDER_LIST_LIMIT = 50;

const router = express.Router();

router.use(authMiddleware);

// Mock payment is test-only; otherwise any member could mark their own order as paid
function testEnvOnly(req, res, next) {
  if (process.env.NODE_ENV !== 'test') {
    return res.status(404).json({ data: null, error: 'NOT_FOUND', message: '找不到該資源' });
  }
  next();
}

/**
 * @openapi
 * /api/orders:
 *   post:
 *     summary: 從購物車建立訂單
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [recipientName, recipientEmail, recipientAddress, shippingMethod, isRemoteArea, isExpress]
 *             properties:
 *               recipientName:
 *                 type: string
 *               recipientEmail:
 *                 type: string
 *                 format: email
 *               recipientAddress:
 *                 type: string
 *               shippingMethod:
 *                 type: string
 *                 enum: [home_delivery, convenience_store]
 *               isRemoteArea:
 *                 type: boolean
 *               isExpress:
 *                 type: boolean
 *               couponCode:
 *                 type: string
 *                 nullable: true
 *                 description: 選填的優惠碼（FLOWER100、SPRING10），不分大小寫，每張訂單最多一組；不帶、null 或空白視為未使用
 *     responses:
 *       201:
 *         description: 訂單建立成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     order_no:
 *                       type: string
 *                     subtotal:
 *                       type: integer
 *                       description: 折扣前的商品小計
 *                     discount:
 *                       type: integer
 *                       description: 優惠碼折抵金額，未使用為 0
 *                     coupon_code:
 *                       type: string
 *                       nullable: true
 *                       description: 使用的優惠碼（大寫），未使用為 null
 *                     shipping_fee:
 *                       type: integer
 *                     shipping_method:
 *                       type: string
 *                       enum: [home_delivery, convenience_store]
 *                     is_remote_area:
 *                       type: boolean
 *                     is_express:
 *                       type: boolean
 *                     total_amount:
 *                       type: integer
 *                       description: 商品小計 - 折扣 + 運費
 *                     status:
 *                       type: string
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           product_name:
 *                             type: string
 *                           product_price:
 *                             type: integer
 *                           quantity:
 *                             type: integer
 *                     created_at:
 *                       type: string
 *                 error:
 *                   type: string
 *                   nullable: true
 *                 message:
 *                   type: string
 *       400:
 *         description: 購物車為空（CART_EMPTY）、庫存不足（STOCK_INSUFFICIENT）、收件資訊或 couponCode 格式錯誤（VALIDATION_ERROR），或優惠碼不可用（COUPON_INVALID 不存在、COUPON_EXPIRED 已失效、COUPON_MIN_SUBTOTAL 未達使用門檻）。任何一種都不會建立訂單、扣庫存或清空購物車
 */
router.post('/', (req, res) => {
  const {
    recipientName,
    recipientEmail,
    recipientAddress,
    shippingMethod,
    isRemoteArea,
    isExpress,
    couponCode
  } = req.body;
  const userId = req.user.userId;

  if (!isNonEmptyString(recipientName) || !isNonEmptyString(recipientEmail) || !isNonEmptyString(recipientAddress)) {
    return res.status(400).json({
      data: null,
      error: 'VALIDATION_ERROR',
      message: '收件人姓名、Email 和地址為必填欄位'
    });
  }

  if (!isValidEmail(recipientEmail)) {
    return res.status(400).json({
      data: null,
      error: 'VALIDATION_ERROR',
      message: 'Email 格式不正確'
    });
  }

  if (!Object.values(SHIPPING_METHODS).includes(shippingMethod)) {
    return res.status(400).json({
      data: null,
      error: 'VALIDATION_ERROR',
      message: 'shippingMethod 必須為 home_delivery 或 convenience_store'
    });
  }

  if (typeof isRemoteArea !== 'boolean' || typeof isExpress !== 'boolean') {
    return res.status(400).json({
      data: null,
      error: 'VALIDATION_ERROR',
      message: 'isRemoteArea 與 isExpress 必須為 boolean'
    });
  }

  // Optional; an array would mean several coupons, and an order takes at most one
  if (couponCode !== undefined && couponCode !== null && typeof couponCode !== 'string') {
    return res.status(400).json({
      data: null,
      error: 'VALIDATION_ERROR',
      message: 'couponCode 必須為字串（每張訂單最多使用一組優惠碼）'
    });
  }

  const cartItems = getCheckoutItems(userId);

  if (cartItems.length === 0) {
    return res.status(400).json({
      data: null,
      error: 'CART_EMPTY',
      message: '購物車為空'
    });
  }

  // Older versions accepted fractional quantities through the cart PATCH endpoint
  if (cartItems.some(item => !Number.isSafeInteger(item.quantity) || item.quantity <= 0)) {
    return res.status(400).json({
      data: null,
      error: 'VALIDATION_ERROR',
      message: '購物車內有無效的商品數量，請重新調整數量後再結帳'
    });
  }

  const insufficientItems = findInsufficientItems(cartItems);
  if (insufficientItems.length > 0) {
    const names = insufficientItems.map(i => i.product_name).join(', ');
    return res.status(400).json({
      data: null,
      error: 'STOCK_INSUFFICIENT',
      message: `以下商品庫存不足：${names}`
    });
  }

  // Calculate the subtotal, the coupon discount and the server-authoritative shipping fee.
  const subtotal = cartItems.reduce(
    (sum, item) => sum + item.product_price * item.quantity, 0
  );

  let coupon;
  try {
    coupon = applyCoupon({ subtotal, couponCode });
  } catch (err) {
    // Nothing has been written yet: no order, no stock deduction, the cart stays as it is
    if (err instanceof CouponError) {
      return res.status(400).json({ data: null, error: err.code, message: err.message });
    }
    throw err;
  }

  // The discount applies to the goods only; shipping, including the free-shipping threshold,
  // is based on what is left after it.
  const shipping = calculateShipping({
    subtotal: coupon.discountedSubtotal,
    method: shippingMethod,
    isRemoteArea,
    isExpress
  });

  let orderId;
  try {
    orderId = createOrderFromCart({
      userId,
      recipient: { name: recipientName, email: recipientEmail, address: recipientAddress },
      delivery: { method: shippingMethod, isRemoteArea, isExpress },
      cartItems,
      subtotal,
      discount: coupon.discount,
      couponCode: coupon.couponCode,
      shipping
    });
  } catch (err) {
    // The stock changed after the check above; the transaction has already rolled back
    if (err instanceof InsufficientStockError) {
      return res.status(400).json({
        data: null,
        error: 'STOCK_INSUFFICIENT',
        message: err.message
      });
    }
    throw err;
  }

  const order = findOrderById(orderId);
  const orderItems = getOrderItemSummaries(orderId);

  res.status(201).json({
    data: {
      id: order.id,
      order_no: order.order_no,
      subtotal: order.subtotal,
      discount: order.discount,
      coupon_code: order.coupon_code,
      shipping_fee: order.shipping_fee,
      shipping_method: order.shipping_method,
      is_remote_area: Boolean(order.is_remote_area),
      is_express: Boolean(order.is_express),
      total_amount: order.total_amount,
      status: order.status,
      items: orderItems,
      created_at: order.created_at
    },
    error: null,
    message: '訂單建立成功'
  });
});

/**
 * @openapi
 * /api/orders:
 *   get:
 *     summary: 自己的訂單列表（可依狀態篩選並分頁）
 *     description: 只回傳自己的訂單，依建立時間由新到舊。與後台列表不同，status、page、limit 不合法時回 400，不會退回預設值。
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         description: 只回傳該狀態的訂單；不帶表示不篩選
 *         schema:
 *           type: string
 *           enum: [pending, paid, failed]
 *       - in: query
 *         name: page
 *         description: 頁碼，正整數
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - in: query
 *         name: limit
 *         description: 每頁筆數，正整數；超過 50 以 50 計
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *           default: 10
 *     responses:
 *       200:
 *         description: 成功（page 超過最後一頁時 orders 為空陣列）
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     orders:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           order_no:
 *                             type: string
 *                           subtotal:
 *                             type: integer
 *                           discount:
 *                             type: integer
 *                           coupon_code:
 *                             type: string
 *                             nullable: true
 *                           shipping_fee:
 *                             type: integer
 *                           shipping_method:
 *                             type: string
 *                           total_amount:
 *                             type: integer
 *                           status:
 *                             type: string
 *                           created_at:
 *                             type: string
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         page:
 *                           type: integer
 *                         limit:
 *                           type: integer
 *                         total:
 *                           type: integer
 *                         totalPages:
 *                           type: integer
 *                 error:
 *                   type: string
 *                   nullable: true
 *                 message:
 *                   type: string
 *       400:
 *         description: status 不在 pending、paid、failed 之內，或 page、limit 不是正整數（VALIDATION_ERROR）
 */
router.get('/', (req, res) => {
  const { status } = req.query;
  if (status !== undefined && !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({
      data: null,
      error: 'VALIDATION_ERROR',
      message: 'status 必須是 pending、paid 或 failed'
    });
  }

  const pagination = parseStrictPagination(req.query, { defaultLimit: 10, maxLimit: MAX_ORDER_LIST_LIMIT });
  if (!pagination) {
    return res.status(400).json({
      data: null,
      error: 'VALIDATION_ERROR',
      message: 'page 與 limit 必須是正整數'
    });
  }

  const { page, limit, offset } = pagination;
  const { orders, total } = listOrdersForUser(req.user.userId, { status, limit, offset });

  res.json({
    data: {
      orders: orders.map(serializeOrder),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    },
    error: null,
    message: '成功'
  });
});

/**
 * @openapi
 * /api/orders/{id}:
 *   get:
 *     summary: 訂單詳情
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     order_no:
 *                       type: string
 *                     recipient_name:
 *                       type: string
 *                     recipient_email:
 *                       type: string
 *                     recipient_address:
 *                       type: string
 *                     subtotal:
 *                       type: integer
 *                     discount:
 *                       type: integer
 *                     coupon_code:
 *                       type: string
 *                       nullable: true
 *                     shipping_fee:
 *                       type: integer
 *                     shipping_method:
 *                       type: string
 *                       enum: [home_delivery, convenience_store]
 *                     is_remote_area:
 *                       type: boolean
 *                     is_express:
 *                       type: boolean
 *                     total_amount:
 *                       type: integer
 *                     status:
 *                       type: string
 *                     created_at:
 *                       type: string
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           product_id:
 *                             type: string
 *                           product_name:
 *                             type: string
 *                           product_price:
 *                             type: integer
 *                           quantity:
 *                             type: integer
 *                 error:
 *                   type: string
 *                   nullable: true
 *                 message:
 *                   type: string
 *       404:
 *         description: 訂單不存在，或不屬於目前的使用者
 */
router.get('/:id', (req, res) => {
  const order = findOrderForUser(req.params.id, req.user.userId);

  if (!order) {
    return res.status(404).json({ data: null, error: 'NOT_FOUND', message: '訂單不存在' });
  }

  const items = getOrderItems(order.id);

  res.json({
    data: { ...serializeOrder(order), items },
    error: null,
    message: '成功'
  });
});

/**
 * @openapi
 * /api/orders/{id}/pay:
 *   patch:
 *     summary: 模擬付款（僅 NODE_ENV=test 開放，其他環境回 404）
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [success, fail]
 *     responses:
 *       200:
 *         description: 付款狀態更新成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     order_no:
 *                       type: string
 *                     total_amount:
 *                       type: integer
 *                     status:
 *                       type: string
 *                     created_at:
 *                       type: string
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           product_name:
 *                             type: string
 *                           product_price:
 *                             type: integer
 *                           quantity:
 *                             type: integer
 *                 error:
 *                   type: string
 *                   nullable: true
 *                 message:
 *                   type: string
 *       400:
 *         description: action 無效或訂單狀態不是 pending
 *       404:
 *         description: 訂單不存在，或非測試環境
 */
router.patch('/:id/pay', testEnvOnly, (req, res) => {
  const { action } = req.body;
  const userId = req.user.userId;

  const actionMap = { success: 'paid', fail: 'failed' };
  if (!action || !actionMap[action]) {
    return res.status(400).json({
      data: null,
      error: 'VALIDATION_ERROR',
      message: 'action 必須為 success 或 fail'
    });
  }

  const order = findOrderForUser(req.params.id, userId);
  if (!order) {
    return res.status(404).json({ data: null, error: 'NOT_FOUND', message: '訂單不存在' });
  }

  if (order.status !== 'pending') {
    return res.status(400).json({
      data: null,
      error: 'INVALID_STATUS',
      message: '訂單狀態不是 pending，無法付款'
    });
  }

  const newStatus = actionMap[action];
  db.prepare("UPDATE orders SET status = ? WHERE id = ? AND status = 'pending'").run(newStatus, order.id);

  const updated = findOrderById(order.id);
  const items = getOrderItems(order.id);

  res.json({
    data: { ...serializeOrder(updated), items },
    error: null,
    message: action === 'success' ? '付款成功' : '付款失敗'
  });
});

/**
 * @openapi
 * /api/orders/{id}/check-payment:
 *   post:
 *     summary: 透過綠界 QueryTradeInfo API 查詢付款狀態
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 查詢成功（已付款、尚未付款，或訂單已非 pending 時回傳目前狀態）
 *       400:
 *         description: 此訂單無綠界交易編號（NO_TRADE_NO）
 *       404:
 *         description: 訂單不存在
 *       500:
 *         description: 綠界查詢失敗，或回應的 CheckMacValue、交易編號、金額驗證不符（ECPAY_QUERY_ERROR）
 */
router.post('/:id/check-payment', async (req, res, next) => {
  // Express 4 does not catch rejections of async handlers, so forward every unexpected error
  try {
    const order = findOrderForUser(req.params.id, req.user.userId);
    if (!order) {
      return res.status(404).json({ data: null, error: 'NOT_FOUND', message: '訂單不存在' });
    }

    if (order.status !== 'pending') {
      const items = getOrderItemSummaries(order.id);
      return res.json({
        data: { ...serializeOrder(order), items },
        error: null,
        message: order.status === 'paid' ? '此訂單已付款' : '此訂單付款失敗'
      });
    }

    if (!order.merchant_trade_no) {
      return res.status(400).json({ data: null, error: 'NO_TRADE_NO', message: '此訂單無綠界交易編號' });
    }

    let tradeInfo;
    let paid;
    try {
      tradeInfo = await queryTradeInfo(order.merchant_trade_no);
      paid = isTradePaid(order, tradeInfo);
    } catch (err) {
      // Only the ECPay request and the verification of its answer are reported as ECPAY_QUERY_ERROR
      console.error('[ECPay] QueryTradeInfo error:', err.message);
      return res.status(500).json({
        data: null,
        error: 'ECPAY_QUERY_ERROR',
        message: '查詢綠界付款狀態失敗，請稍後再試'
      });
    }

    if (paid) {
      markOrderPaid(order.id);
      const updated = findOrderById(order.id);
      const items = getOrderItemSummaries(order.id);
      return res.json({
        data: { ...serializeOrder(updated), items },
        error: null,
        message: '付款成功'
      });
    }

    const items = getOrderItemSummaries(order.id);
    return res.json({
      data: { ...serializeOrder(order), items, ecpay_trade_status: tradeInfo.TradeStatus },
      error: null,
      message: '尚未完成付款，請稍後再查詢'
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
