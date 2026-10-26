const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../setup/testServer');
const {
  ECPAY_CONFIG,
  generateCheckMacValue,
  verifyCheckMacValue
} = require('../../src/utils/ecpay');
const {
  createOrderFromCart,
  getCheckoutItems,
  InsufficientStockError
} = require('../../src/services/orderService');
const { calculateShipping } = require('../../src/utils/shipping');
const {
  db,
  resetDatabase,
  createProduct,
  getMainDatabaseInfo
} = require('./helpers');

const ORDER_PAYLOAD = {
  recipientName: '整合測試收件人',
  recipientEmail: 'recipient.integration@example.com',
  recipientAddress: '台北市信義區測試路 100 號',
  shippingMethod: 'convenience_store',
  isRemoteArea: true,
  isExpress: true
};

function expectEnvelope(response, status) {
  expect(response.status).toBe(status);
  expect(response.body).toHaveProperty('data');
  expect(response.body).toHaveProperty('error');
  expect(response.body).toHaveProperty('message');
}

async function registerMember(email = 'integration-member@example.com') {
  const response = await request(app)
    .post('/api/auth/register')
    .send({
      email,
      password: 'password123',
      name: '整合測試會員'
    });

  expectEnvelope(response, 201);
  expect(response.body.error).toBeNull();
  return response.body.data;
}

async function addProductToCart(token, productId, quantity) {
  const response = await request(app)
    .post('/api/cart')
    .set('Authorization', `Bearer ${token}`)
    .send({ productId, quantity });

  expectEnvelope(response, 200);
  expect(response.body.error).toBeNull();
  return response.body.data;
}

async function createPendingOrder(product, email = 'payment-member@example.com') {
  const member = await registerMember(email);
  await addProductToCart(member.token, product.id, 2);

  const response = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${member.token}`)
    .send(ORDER_PAYLOAD);

  expectEnvelope(response, 201);
  return {
    token: member.token,
    user: member.user,
    order: response.body.data
  };
}

// Build a QueryTradeInfo response body signed like ECPay does
function signedTradeInfo(params) {
  const signed = {
    ...params,
    CheckMacValue: generateCheckMacValue(params, ECPAY_CONFIG.hashKey, ECPAY_CONFIG.hashIV)
  };
  return new URLSearchParams(signed).toString();
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseHiddenInputs(html) {
  const params = {};
  const pattern = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g;
  for (const match of html.matchAll(pattern)) {
    params[match[1]] = decodeHtmlAttribute(match[2]);
  }
  return params;
}

describe('Order checkout integration flow', () => {
  let primaryProduct;

  beforeEach(() => {
    resetDatabase();
    primaryProduct = createProduct();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetDatabase();
  });

  afterAll(() => {
    db.close();
  });

  it('uses an isolated in-memory SQLite database', () => {
    const mainDatabase = getMainDatabaseInfo();

    expect(mainDatabase).toBeDefined();
    expect(mainDatabase.file).toBe('');
  });

  it('renders the cart and checkout entry points used by the frontend', async () => {
    const cartPage = await request(app).get('/cart');
    expect(cartPage.status).toBe(200);
    expect(cartPage.type).toBe('text/html');
    expect(cartPage.text).toContain('購物車');

    const checkoutPage = await request(app).get('/checkout');
    expect(checkoutPage.status).toBe(200);
    expect(checkoutPage.type).toBe('text/html');
    expect(checkoutPage.text).toContain('value="home_delivery"');
    expect(checkoutPage.text).toContain('value="convenience_store"');
    expect(checkoutPage.text).toContain('form.isRemoteArea');
    expect(checkoutPage.text).toContain('form.isExpress');

    const checkoutScript = await request(app).get('/js/pages/checkout.js');
    expect(checkoutScript.status).toBe(200);
    expect(checkoutScript.type).toMatch(/javascript/);
    expect(checkoutScript.text).toContain("apiFetch('/api/orders'");
    expect(checkoutScript.text).toContain('shippingMethod');
  });

  it('creates a member, cart, shipping order and persists every expected state change', async () => {
    const registerResponse = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'complete-flow@example.com',
        password: 'password123',
        name: '完整流程會員'
      });

    expectEnvelope(registerResponse, 201);
    expect(registerResponse.body.error).toBeNull();
    expect(registerResponse.body.data.token).toEqual(expect.any(String));
    const { token, user } = registerResponse.body.data;

    const productResponse = await request(app).get('/api/products?page=1&limit=100');
    expectEnvelope(productResponse, 200);
    expect(productResponse.body.error).toBeNull();
    expect(productResponse.body.data.products).toHaveLength(1);
    expect(productResponse.body.data.products[0]).toMatchObject({
      id: primaryProduct.id,
      price: 700,
      stock: 10
    });

    const cartResponse = await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: primaryProduct.id, quantity: 2 });

    expectEnvelope(cartResponse, 200);
    expect(cartResponse.body.error).toBeNull();
    expect(cartResponse.body.data).toMatchObject({
      product_id: primaryProduct.id,
      quantity: 2
    });

    const orderResponse = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send(ORDER_PAYLOAD);

    expectEnvelope(orderResponse, 201);
    expect(orderResponse.body.error).toBeNull();
    expect(orderResponse.body.data).toMatchObject({
      subtotal: 1400,
      shipping_fee: 510,
      shipping_method: 'convenience_store',
      is_remote_area: true,
      is_express: true,
      total_amount: 1910,
      status: 'pending'
    });
    expect(orderResponse.body.data.items).toEqual([
      {
        product_name: primaryProduct.name,
        product_price: 700,
        quantity: 2
      }
    ]);

    const orderId = orderResponse.body.data.id;
    const storedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    expect(storedOrder).toMatchObject({
      user_id: user.id,
      recipient_name: ORDER_PAYLOAD.recipientName,
      recipient_email: ORDER_PAYLOAD.recipientEmail,
      recipient_address: ORDER_PAYLOAD.recipientAddress,
      subtotal: 1400,
      shipping_fee: 510,
      shipping_method: 'convenience_store',
      is_remote_area: 1,
      is_express: 1,
      total_amount: 1910,
      status: 'pending'
    });
    expect(storedOrder.merchant_trade_no).toMatch(/^ORD\d{8}[A-F0-9]{5}$/);

    const storedItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    expect(storedItems).toHaveLength(1);
    expect(storedItems[0]).toMatchObject({
      product_id: primaryProduct.id,
      product_name: primaryProduct.name,
      product_price: 700,
      quantity: 2
    });

    const storedProduct = db.prepare('SELECT stock FROM products WHERE id = ?').get(primaryProduct.id);
    expect(storedProduct.stock).toBe(8);

    const cartCount = db.prepare(
      'SELECT COUNT(*) AS count FROM cart_items WHERE user_id = ?'
    ).get(user.id);
    expect(cartCount.count).toBe(0);

    const detailResponse = await request(app)
      .get(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${token}`);
    expectEnvelope(detailResponse, 200);
    expect(detailResponse.body.data).toMatchObject({
      id: orderId,
      subtotal: 1400,
      shipping_fee: 510,
      total_amount: 1910
    });
    expect(detailResponse.body.data.items).toHaveLength(1);
  });

  it('does not create an order or deduct stock when current stock is insufficient', async () => {
    const member = await registerMember('insufficient-stock@example.com');
    await addProductToCart(member.token, primaryProduct.id, 3);

    db.prepare('UPDATE products SET stock = 1 WHERE id = ?').run(primaryProduct.id);

    const response = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${member.token}`)
      .send(ORDER_PAYLOAD);

    expectEnvelope(response, 400);
    expect(response.body.data).toBeNull();
    expect(response.body.error).toBe('STOCK_INSUFFICIENT');
    expect(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM order_items').get().count).toBe(0);
    expect(db.prepare('SELECT stock FROM products WHERE id = ?').get(primaryProduct.id).stock).toBe(1);

    const cartItem = db.prepare(
      'SELECT quantity FROM cart_items WHERE user_id = ? AND product_id = ?'
    ).get(member.user.id, primaryProduct.id);
    expect(cartItem.quantity).toBe(3);
  });

  it('rolls back the entire transaction when an order item insert fails midway', async () => {
    const secondProduct = createProduct({
      name: '回滾測試花束',
      price: 300,
      stock: 6
    });
    const member = await registerMember('rollback@example.com');
    await addProductToCart(member.token, primaryProduct.id, 2);
    await addProductToCart(member.token, secondProduct.id, 1);

    db.exec(`
      CREATE TRIGGER integration_fail_second_order_item
      BEFORE INSERT ON order_items
      WHEN (SELECT COUNT(*) FROM order_items WHERE order_id = NEW.order_id) >= 1
      BEGIN
        SELECT RAISE(ABORT, 'forced integration rollback');
      END;
    `);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${member.token}`)
      .send(ORDER_PAYLOAD);

    expectEnvelope(response, 500);
    expect(response.body).toEqual({
      data: null,
      error: 'INTERNAL_ERROR',
      message: '伺服器內部錯誤'
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM order_items').get().count).toBe(0);
    expect(db.prepare('SELECT stock FROM products WHERE id = ?').get(primaryProduct.id).stock).toBe(10);
    expect(db.prepare('SELECT stock FROM products WHERE id = ?').get(secondProduct.id).stock).toBe(6);
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM cart_items WHERE user_id = ?'
    ).get(member.user.id).count).toBe(2);
  });

  it('builds a valid ECPay staging form with the persisted order total', async () => {
    const { order } = await createPendingOrder(primaryProduct, 'ecpay-form@example.com');
    const response = await request(app).get(`/ecpay/payment/${order.id}`);

    expect(response.status).toBe(200);
    expect(response.type).toBe('text/html');
    expect(response.text).toContain(`action="${ECPAY_CONFIG.aioCheckOutUrl}"`);

    const params = parseHiddenInputs(response.text);
    expect(params).toMatchObject({
      MerchantID: ECPAY_CONFIG.merchantId,
      MerchantTradeNo: order.order_no.replace(/-/g, ''),
      TotalAmount: '1910',
      ItemName: `${primaryProduct.name} x2`,
      ReturnURL: 'http://localhost:3001/ecpay/notify',
      ClientBackURL: `http://localhost:3001/orders/${order.id}?payment=pending`,
      ChoosePayment: 'ALL',
      EncryptType: '1'
    });
    expect(params.CheckMacValue).toMatch(/^[A-F0-9]{64}$/);
    expect(verifyCheckMacValue(
      params,
      ECPAY_CONFIG.hashKey,
      ECPAY_CONFIG.hashIV
    )).toBe(true);
  });

  it('marks the order paid after a successful mocked QueryTradeInfo response', async () => {
    const { token, order } = await createPendingOrder(primaryProduct, 'ecpay-paid@example.com');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => signedTradeInfo({
        MerchantID: ECPAY_CONFIG.merchantId,
        MerchantTradeNo: order.order_no.replace(/-/g, ''),
        TradeAmt: String(order.total_amount),
        TradeStatus: '1'
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(app)
      .post(`/api/orders/${order.id}/check-payment`)
      .set('Authorization', `Bearer ${token}`);

    expectEnvelope(response, 200);
    expect(response.body.error).toBeNull();
    expect(response.body.data.status).toBe('paid');
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status).toBe('paid');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(ECPAY_CONFIG.queryTradeInfoUrl);
    expect(options.method).toBe('POST');
    // A slow ECPay response must not hold the request open indefinitely
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
    const requestParams = Object.fromEntries(new URLSearchParams(options.body));
    expect(requestParams).toMatchObject({
      MerchantID: ECPAY_CONFIG.merchantId,
      MerchantTradeNo: order.order_no.replace(/-/g, '')
    });
    expect(Number(requestParams.TimeStamp)).toBeGreaterThan(0);
    expect(verifyCheckMacValue(
      requestParams,
      ECPAY_CONFIG.hashKey,
      ECPAY_CONFIG.hashIV
    )).toBe(true);
  });

  it('keeps the order pending when mocked ECPay reports unpaid', async () => {
    const { token, order } = await createPendingOrder(primaryProduct, 'ecpay-pending@example.com');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `MerchantID=${ECPAY_CONFIG.merchantId}&TradeStatus=0&RtnCode=0`
    }));

    const response = await request(app)
      .post(`/api/orders/${order.id}/check-payment`)
      .set('Authorization', `Bearer ${token}`);

    expectEnvelope(response, 200);
    expect(response.body.data.status).toBe('pending');
    expect(response.body.data.ecpay_trade_status).toBe('0');
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status).toBe('pending');
  });

  it('keeps the order pending when the mocked ECPay query fails', async () => {
    const { token, order } = await createPendingOrder(primaryProduct, 'ecpay-error@example.com');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => ''
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request(app)
      .post(`/api/orders/${order.id}/check-payment`)
      .set('Authorization', `Bearer ${token}`);

    expectEnvelope(response, 500);
    expect(response.body.data).toBeNull();
    expect(response.body.error).toBe('ECPAY_QUERY_ERROR');
    expect(response.body.message).not.toContain('503');
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status).toBe('pending');
  });

  it('keeps the order pending when a paid response fails verification', async () => {
    const { token, order } = await createPendingOrder(primaryProduct, 'ecpay-forged@example.com');
    const merchantTradeNo = order.order_no.replace(/-/g, '');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const forgedResponses = [
      // Tampered signature
      `MerchantID=${ECPAY_CONFIG.merchantId}&MerchantTradeNo=${merchantTradeNo}&TradeAmt=${order.total_amount}&TradeStatus=1&CheckMacValue=${'0'.repeat(64)}`,
      // No signature at all
      `MerchantID=${ECPAY_CONFIG.merchantId}&MerchantTradeNo=${merchantTradeNo}&TradeAmt=${order.total_amount}&TradeStatus=1`,
      // Valid signature but a different amount
      signedTradeInfo({
        MerchantID: ECPAY_CONFIG.merchantId,
        MerchantTradeNo: merchantTradeNo,
        TradeAmt: '1',
        TradeStatus: '1'
      }),
      // Valid signature but for a different trade number
      signedTradeInfo({
        MerchantID: ECPAY_CONFIG.merchantId,
        MerchantTradeNo: 'ORD00000000AAAAA',
        TradeAmt: String(order.total_amount),
        TradeStatus: '1'
      })
    ];

    for (const body of forgedResponses) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => body
      }));

      const response = await request(app)
        .post(`/api/orders/${order.id}/check-payment`)
        .set('Authorization', `Bearer ${token}`);

      expectEnvelope(response, 500);
      expect(response.body.data).toBeNull();
      expect(response.body.error).toBe('ECPAY_QUERY_ERROR');
      expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status).toBe('pending');
    }
  });

  it('does not query ECPay again for an order that is already paid', async () => {
    const { token, order } = await createPendingOrder(primaryProduct, 'already-paid@example.com');
    db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(order.id);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(app)
      .post(`/api/orders/${order.id}/check-payment`)
      .set('Authorization', `Bearer ${token}`);

    expectEnvelope(response, 200);
    expect(response.body.message).toBe('此訂單已付款');
    expect(response.body.data.status).toBe('paid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports NO_TRADE_NO and builds no payment form for an order without a trade number', async () => {
    const { token, order } = await createPendingOrder(primaryProduct, 'no-trade-no@example.com');
    db.prepare('UPDATE orders SET merchant_trade_no = NULL WHERE id = ?').run(order.id);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const check = await request(app)
      .post(`/api/orders/${order.id}/check-payment`)
      .set('Authorization', `Bearer ${token}`);

    expectEnvelope(check, 400);
    expect(check.body.error).toBe('NO_TRADE_NO');
    expect(fetchMock).not.toHaveBeenCalled();

    const page = await request(app).get(`/ecpay/payment/${order.id}`);
    expect(page.status).toBe(400);
    expect(page.text).not.toContain('<form');
  });

  it('does not report a database failure as an ECPay query error', async () => {
    const { token, order } = await createPendingOrder(primaryProduct, 'db-failure@example.com');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => signedTradeInfo({
        MerchantID: ECPAY_CONFIG.merchantId,
        MerchantTradeNo: order.order_no.replace(/-/g, ''),
        TradeAmt: String(order.total_amount),
        TradeStatus: '1'
      })
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec(`
      CREATE TRIGGER integration_fail_order_update
      BEFORE UPDATE ON orders
      BEGIN
        SELECT RAISE(ABORT, 'forced integration failure');
      END;
    `);

    const response = await request(app)
      .post(`/api/orders/${order.id}/check-payment`)
      .set('Authorization', `Bearer ${token}`);

    expectEnvelope(response, 500);
    expect(response.body).toEqual({
      data: null,
      error: 'INTERNAL_ERROR',
      message: '伺服器內部錯誤'
    });
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status).toBe('pending');
  });

  it('answers STOCK_INSUFFICIENT and rolls back when duplicate cart rows exceed the stock together', async () => {
    const member = await registerMember('duplicate-rows@example.com');
    db.prepare('UPDATE products SET stock = 4 WHERE id = ?').run(primaryProduct.id);
    await addProductToCart(member.token, primaryProduct.id, 3);
    // cart_items has no UNIQUE constraint, so existing data can hold two rows for one product
    db.prepare('INSERT INTO cart_items (id, user_id, product_id, quantity) VALUES (?, ?, ?, ?)')
      .run(uuidv4(), member.user.id, primaryProduct.id, 3);

    const response = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${member.token}`)
      .send(ORDER_PAYLOAD);

    expectEnvelope(response, 400);
    expect(response.body.data).toBeNull();
    expect(response.body.error).toBe('STOCK_INSUFFICIENT');
    expect(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM order_items').get().count).toBe(0);
    expect(db.prepare('SELECT stock FROM products WHERE id = ?').get(primaryProduct.id).stock).toBe(4);
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM cart_items WHERE user_id = ?'
    ).get(member.user.id).count).toBe(2);
  });

  it('refuses to deduct stock below zero when the stock check was stale', async () => {
    const member = await registerMember('stale-stock@example.com');
    await addProductToCart(member.token, primaryProduct.id, 3);
    const cartItems = getCheckoutItems(member.user.id);
    const subtotal = 3 * primaryProduct.price;

    // Another buyer takes the stock after the caller's own check, before the transaction starts
    db.prepare('UPDATE products SET stock = 1 WHERE id = ?').run(primaryProduct.id);

    expect(() => createOrderFromCart({
      userId: member.user.id,
      recipient: {
        name: ORDER_PAYLOAD.recipientName,
        email: ORDER_PAYLOAD.recipientEmail,
        address: ORDER_PAYLOAD.recipientAddress
      },
      delivery: { method: 'home_delivery', isRemoteArea: false, isExpress: false },
      cartItems,
      subtotal,
      shipping: calculateShipping({ subtotal, method: 'home_delivery' })
    })).toThrow(InsufficientStockError);

    expect(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM order_items').get().count).toBe(0);
    expect(db.prepare('SELECT stock FROM products WHERE id = ?').get(primaryProduct.id).stock).toBe(1);
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM cart_items WHERE user_id = ?'
    ).get(member.user.id).count).toBe(1);
  });

  it('charges ECPay the discounted total and only accepts a payment of that amount', async () => {
    const product = createProduct({ name: '優惠碼整合測試花束', price: 1000, stock: 10 });
    const member = await registerMember('coupon-flow@example.com');
    await addProductToCart(member.token, product.id, 2);

    const orderResponse = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ...ORDER_PAYLOAD, couponCode: 'spring10' });

    // 2,000 - 200 = 1,800 keeps the base shipping free; remote area 200 + express 250 still apply
    expectEnvelope(orderResponse, 201);
    expect(orderResponse.body.data).toMatchObject({
      subtotal: 2000,
      discount: 200,
      shipping_fee: 450,
      total_amount: 2250,
      coupon_code: 'SPRING10'
    });
    const order = orderResponse.body.data;

    expect(db.prepare(
      'SELECT subtotal, discount, coupon_code, shipping_fee, total_amount FROM orders WHERE id = ?'
    ).get(order.id)).toEqual({
      subtotal: 2000,
      discount: 200,
      coupon_code: 'SPRING10',
      shipping_fee: 450,
      total_amount: 2250
    });
    expect(db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id).stock).toBe(8);

    // The ECPay form asks for the discounted total
    const form = await request(app).get(`/ecpay/payment/${order.id}`);
    expect(parseHiddenInputs(form.text).TotalAmount).toBe('2250');

    const merchantTradeNo = order.order_no.replace(/-/g, '');
    const paidAnswer = (tradeAmount) => vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => signedTradeInfo({
        MerchantID: ECPAY_CONFIG.merchantId,
        MerchantTradeNo: merchantTradeNo,
        TradeAmt: String(tradeAmount),
        TradeStatus: '1'
      })
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // A payment of the amount without the discount does not belong to this order
    vi.stubGlobal('fetch', paidAnswer(2450));
    const wrongAmount = await request(app)
      .post(`/api/orders/${order.id}/check-payment`)
      .set('Authorization', `Bearer ${member.token}`);
    expectEnvelope(wrongAmount, 500);
    expect(wrongAmount.body.error).toBe('ECPAY_QUERY_ERROR');
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status).toBe('pending');

    vi.stubGlobal('fetch', paidAnswer(2250));
    const paid = await request(app)
      .post(`/api/orders/${order.id}/check-payment`)
      .set('Authorization', `Bearer ${member.token}`);
    expectEnvelope(paid, 200);
    expect(paid.body.data).toMatchObject({ status: 'paid', discount: 200, coupon_code: 'SPRING10' });
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status).toBe('paid');
  });

  it('rejects non-integer quantities at the service layer', async () => {
    const member = await registerMember('service-fraction@example.com');
    const subtotal = 1050;

    expect(() => createOrderFromCart({
      userId: member.user.id,
      recipient: {
        name: ORDER_PAYLOAD.recipientName,
        email: ORDER_PAYLOAD.recipientEmail,
        address: ORDER_PAYLOAD.recipientAddress
      },
      delivery: { method: 'home_delivery', isRemoteArea: false, isExpress: false },
      cartItems: [{
        id: uuidv4(),
        product_id: primaryProduct.id,
        quantity: 1.5,
        product_name: primaryProduct.name,
        product_price: primaryProduct.price,
        product_stock: primaryProduct.stock
      }],
      subtotal,
      shipping: { subtotal, shippingFee: 0, totalAmount: subtotal }
    })).toThrow(TypeError);

    expect(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count).toBe(0);
    expect(db.prepare('SELECT stock FROM products WHERE id = ?').get(primaryProduct.id).stock).toBe(10);
  });
});
