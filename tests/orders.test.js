const { v4: uuidv4 } = require('uuid');
const db = require('../src/database');
const { app, request, getAdminToken, registerUser } = require('./setup');

describe('Orders API', () => {
  let userToken;
  let productId;
  let productPrice;
  let orderId;

  beforeAll(async () => {
    // Register a user for order tests
    const { token } = await registerUser();
    userToken = token;

    // Pick a product below the free-shipping threshold so the expected fee is a fixed number
    const prodRes = await request(app).get('/api/products?limit=100');
    const product = prodRes.body.data.products.find(item => item.price < 1500 && item.stock >= 1);
    productId = product.id;
    productPrice = product.price;

    // Add product to cart
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ productId, quantity: 1 });
  });

  it('should create an order from cart', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        recipientName: '測試收件人',
        recipientEmail: 'recipient@example.com',
        recipientAddress: '台北市測試路 123 號',
        shippingMethod: 'convenience_store',
        isRemoteArea: true,
        isExpress: true,
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('error', null);
    expect(res.body).toHaveProperty('message');
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data).toHaveProperty('order_no');
    expect(res.body.data).toHaveProperty('subtotal', productPrice);
    // convenience store 60 + remote area 200 + same-day express 250
    expect(res.body.data).toHaveProperty('shipping_fee', 510);
    expect(res.body.data).toHaveProperty('shipping_method', 'convenience_store');
    expect(res.body.data).toHaveProperty('is_remote_area', true);
    expect(res.body.data).toHaveProperty('is_express', true);
    expect(res.body.data).toHaveProperty('total_amount');
    expect(res.body.data.total_amount).toBe(
      res.body.data.subtotal + res.body.data.shipping_fee
    );
    expect(res.body.data).toHaveProperty('status', 'pending');
    expect(res.body.data).toHaveProperty('items');
    expect(Array.isArray(res.body.data.items)).toBe(true);

    orderId = res.body.data.id;
  });

  it('should fail to create order with empty cart', async () => {
    // The cart was already cleared by the previous order
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        recipientName: '測試收件人',
        recipientEmail: 'recipient@example.com',
        recipientAddress: '台北市測試路 123 號',
        shippingMethod: 'home_delivery',
        isRemoteArea: false,
        isExpress: false,
      });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('data', null);
    expect(res.body).toHaveProperty('error', 'CART_EMPTY');
  });

  it('should fail to create order without auth', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        recipientName: '測試收件人',
        recipientEmail: 'recipient@example.com',
        recipientAddress: '台北市測試路 123 號',
      });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).not.toBeNull();
  });

  it('should get order list', async () => {
    const res = await request(app)
      .get('/api/orders')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('error', null);
    expect(res.body.data).toHaveProperty('orders');
    expect(Array.isArray(res.body.data.orders)).toBe(true);
    expect(res.body.data.orders.length).toBeGreaterThan(0);
  });

  it('should get order detail', async () => {
    const res = await request(app)
      .get(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('error', null);
    expect(res.body.data).toHaveProperty('id', orderId);
    expect(res.body.data).toHaveProperty('order_no');
    expect(res.body.data).toHaveProperty('subtotal', productPrice);
    expect(res.body.data).toHaveProperty('shipping_fee');
    expect(res.body.data).toHaveProperty('shipping_method', 'convenience_store');
    expect(res.body.data).toHaveProperty('is_remote_area', true);
    expect(res.body.data).toHaveProperty('is_express', true);
    expect(res.body.data.total_amount).toBe(
      res.body.data.subtotal + res.body.data.shipping_fee
    );
    expect(res.body.data).toHaveProperty('items');
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  it('should return 404 for non-existent order', async () => {
    const res = await request(app)
      .get('/api/orders/non-existent-order-id')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('data', null);
    expect(res.body).toHaveProperty('error', 'NOT_FOUND');
  });

  it('should reject non-string recipient fields', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        recipientName: { first: '測試' },
        recipientEmail: 'recipient@example.com',
        recipientAddress: '台北市測試路 123 號',
        shippingMethod: 'home_delivery',
        isRemoteArea: false,
        isExpress: false,
      });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('data', null);
    expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
  });

  it('should hide mock payment outside the test environment', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const res = await request(app)
        .patch(`/api/orders/${orderId}/pay`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ action: 'success' });

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('data', null);
      expect(res.body).toHaveProperty('error', 'NOT_FOUND');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('should mock payment once in the test environment', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/pay`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ action: 'success' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('error', null);
    expect(res.body.data).toHaveProperty('status', 'paid');

    const again = await request(app)
      .patch(`/api/orders/${orderId}/pay`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ action: 'fail' });

    expect(again.status).toBe(400);
    expect(again.body).toHaveProperty('error', 'INVALID_STATUS');
  });
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const VALID_ORDER = {
  recipientName: '驗證收件人',
  recipientEmail: 'validation@example.com',
  recipientAddress: '台北市驗證路 1 號',
  shippingMethod: 'home_delivery',
  isRemoteArea: false,
  isExpress: false,
};

async function createProduct(adminToken, { name, price, stock }) {
  const res = await request(app)
    .post('/api/admin/products')
    .set(auth(adminToken))
    .send({ name, price, stock });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('Order creation input validation', () => {
  let token;

  beforeAll(async () => {
    token = (await registerUser()).token;
  });

  it.each([
    ['a missing recipient name', { recipientName: undefined }],
    ['a blank recipient name', { recipientName: '   ' }],
    ['a missing address', { recipientAddress: undefined }],
    ['a missing email', { recipientEmail: undefined }],
    ['an email without @', { recipientEmail: 'recipient.example.com' }],
    ['an email without a dot in the domain', { recipientEmail: 'recipient@example' }],
    ['an email longer than 254 characters', { recipientEmail: `${'a'.repeat(250)}@example.com` }],
    ['an unknown shipping method', { shippingMethod: 'drone' }],
    ['a missing shipping method', { shippingMethod: undefined }],
    ['a string isRemoteArea', { isRemoteArea: 'true' }],
    ['a numeric isExpress', { isExpress: 1 }],
  ])('rejects %s', async (_label, overrides) => {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(token))
      .send({ ...VALID_ORDER, ...overrides });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('data', null);
    expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
  });

  it('rejects a pathological email quickly instead of stalling the server', async () => {
    const start = Date.now();
    const res = await request(app)
      .post('/api/orders')
      .set(auth(token))
      .send({ ...VALID_ORDER, recipientEmail: `a@${'.'.repeat(90000)} ` });

    expect(res.status).toBe(400);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('Order amounts are computed by the server', () => {
  let adminToken;

  beforeAll(async () => {
    adminToken = await getAdminToken();
  });

  it('ignores amounts supplied by the client', async () => {
    const product = await createProduct(adminToken, { name: '金額防竄改花束', price: 600, stock: 5 });
    const { token } = await registerUser();
    await request(app).post('/api/cart').set(auth(token)).send({ productId: product.id, quantity: 2 });

    const res = await request(app)
      .post('/api/orders')
      .set(auth(token))
      .send({
        ...VALID_ORDER,
        subtotal: 1,
        shippingFee: 0,
        shipping_fee: 0,
        totalAmount: 1,
        total_amount: 1,
      });

    expect(res.status).toBe(201);
    // 600 x 2 = 1200 is below the free-shipping threshold, so home delivery costs 120
    expect(res.body.data).toMatchObject({ subtotal: 1200, shipping_fee: 120, total_amount: 1320 });
  });

  it.each([
    [1499, 'home_delivery', 120],
    [1499, 'convenience_store', 60],
    [1500, 'home_delivery', 0],
    [1500, 'convenience_store', 0],
    [1501, 'home_delivery', 0],
  ])('charges the right shipping for a %i subtotal (%s)', async (price, shippingMethod, expectedFee) => {
    const product = await createProduct(adminToken, { name: `運費邊界花束 ${price}`, price, stock: 5 });
    const { token } = await registerUser();
    await request(app).post('/api/cart').set(auth(token)).send({ productId: product.id, quantity: 1 });

    const res = await request(app)
      .post('/api/orders')
      .set(auth(token))
      .send({ ...VALID_ORDER, shippingMethod });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      subtotal: price,
      shipping_fee: expectedFee,
      total_amount: price + expectedFee,
    });
  });
});

describe('Cart integrity at checkout', () => {
  it('refuses a cart row with a fractional quantity left over from older data', async () => {
    const adminToken = await getAdminToken();
    const product = await createProduct(adminToken, { name: '舊資料花束', price: 800, stock: 5 });
    const { token, user } = await registerUser();

    // The API no longer accepts fractions, so write the row directly like older versions could
    db.prepare('INSERT INTO cart_items (id, user_id, product_id, quantity) VALUES (?, ?, ?, ?)')
      .run(uuidv4(), user.id, product.id, 1.5);

    const res = await request(app).post('/api/orders').set(auth(token)).send(VALID_ORDER);

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('data', null);
    expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
    expect(db.prepare('SELECT COUNT(*) AS count FROM orders WHERE user_id = ?').get(user.id).count).toBe(0);
    expect(db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id).stock).toBe(5);
  });
});
