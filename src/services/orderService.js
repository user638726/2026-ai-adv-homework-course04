const { v4: uuidv4 } = require('uuid');
const db = require('../database');

function generateOrderNo() {
  // Use Taipei date so the order number matches ECPay MerchantTradeDate
  const dateStr = new Date()
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })
    .replace(/-/g, '');
  const random = uuidv4().slice(0, 5).toUpperCase();
  return `ORD-${dateStr}-${random}`;
}

const MAX_ORDER_NO_ATTEMPTS = 10;

/**
 * Draw order numbers until one is not taken yet. The random part has only 16^5 values per
 * day, so a collision is rare but possible, and it must not turn into a failed checkout.
 */
function generateUniqueOrderNo(exists, generate = generateOrderNo, maxAttempts = MAX_ORDER_NO_ATTEMPTS) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const orderNo = generate();
    if (!exists(orderNo)) return orderNo;
  }
  throw new Error(`Could not generate a unique order number after ${maxAttempts} attempts`);
}

// Thrown when the stock changed between the caller's check and the deduction
class InsufficientStockError extends Error {
  constructor(productNames) {
    super(`以下商品庫存不足：${productNames.join(', ')}`);
    this.name = 'InsufficientStockError';
    this.productNames = productNames;
  }
}

function serializeOrder(order) {
  return {
    ...order,
    is_remote_area: Boolean(order.is_remote_area),
    is_express: Boolean(order.is_express)
  };
}

function findOrderById(orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

function findOrderForUser(orderId, userId) {
  return db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId);
}

function listOrdersForUser(userId) {
  return db.prepare(
    `SELECT id, order_no, subtotal, shipping_fee, shipping_method,
            is_remote_area, is_express, total_amount, status, created_at
     FROM orders WHERE user_id = ? ORDER BY created_at DESC, rowid DESC`
  ).all(userId);
}

function getOrderItems(orderId) {
  return db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
}

function getOrderItemSummaries(orderId) {
  return db.prepare(
    'SELECT product_name, product_price, quantity FROM order_items WHERE order_id = ?'
  ).all(orderId);
}

// Cart items joined with the current product price and stock
function getCheckoutItems(userId) {
  return db.prepare(
    `SELECT ci.id, ci.product_id, ci.quantity,
            p.name as product_name, p.price as product_price, p.stock as product_stock
     FROM cart_items ci
     JOIN products p ON ci.product_id = p.id
     WHERE ci.user_id = ?`
  ).all(userId);
}

function findInsufficientItems(cartItems) {
  return cartItems.filter(item => item.quantity > item.product_stock);
}

// Callers validate user input first; this guards the invariants the amounts rely on
function assertValidCheckout({ cartItems, subtotal, shipping }) {
  for (const item of cartItems) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new TypeError(`Invalid cart quantity for product ${item.product_id}: ${item.quantity}`);
    }
  }
  if (!Number.isSafeInteger(subtotal) || shipping.subtotal !== subtotal) {
    throw new TypeError('Order subtotal must be an integer that matches the shipping calculation');
  }
}

/**
 * Create an order from the member's cart in one transaction:
 * insert order → snapshot items → deduct stock → clear cart.
 * Amounts must already be calculated by the caller.
 * Throws InsufficientStockError (and rolls everything back) if any product no longer has enough stock.
 */
function createOrderFromCart({ userId, recipient, delivery, cartItems, subtotal, shipping }) {
  assertValidCheckout({ cartItems, subtotal, shipping });

  const orderId = uuidv4();

  const orderNoTaken = db.prepare('SELECT 1 FROM orders WHERE order_no = ?');
  const insertOrder = db.prepare(
    `INSERT INTO orders (
       id, order_no, user_id, recipient_name, recipient_email, recipient_address,
       subtotal, shipping_fee, shipping_method, is_remote_area, is_express,
       total_amount, merchant_trade_no
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertItem = db.prepare(
    `INSERT INTO order_items (id, order_id, product_id, product_name, product_price, quantity)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  // The stock condition makes the deduction itself the authoritative check: the caller's
  // earlier check can be stale by the time this transaction runs.
  const deductStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
  const clearCart = db.prepare('DELETE FROM cart_items WHERE user_id = ?');

  // IMMEDIATE takes the write lock when the transaction starts, so another process cannot
  // slip a competing purchase in between the statements below.
  db.transaction(() => {
    const orderNo = generateUniqueOrderNo(candidate => Boolean(orderNoTaken.get(candidate)));
    const merchantTradeNo = orderNo.replace(/-/g, '');

    insertOrder.run(
      orderId,
      orderNo,
      userId,
      recipient.name,
      recipient.email,
      recipient.address,
      subtotal,
      shipping.shippingFee,
      delivery.method,
      delivery.isRemoteArea ? 1 : 0,
      delivery.isExpress ? 1 : 0,
      shipping.totalAmount,
      merchantTradeNo
    );

    for (const item of cartItems) {
      insertItem.run(uuidv4(), orderId, item.product_id, item.product_name, item.product_price, item.quantity);
      const deducted = deductStock.run(item.quantity, item.product_id, item.quantity);
      if (deducted.changes === 0) {
        throw new InsufficientStockError([item.product_name]);
      }
    }

    clearCart.run(userId);
  }).immediate();

  return orderId;
}

module.exports = {
  InsufficientStockError,
  generateOrderNo,
  generateUniqueOrderNo,
  serializeOrder,
  findOrderById,
  findOrderForUser,
  listOrdersForUser,
  getOrderItems,
  getOrderItemSummaries,
  getCheckoutItems,
  findInsufficientItems,
  createOrderFromCart
};
