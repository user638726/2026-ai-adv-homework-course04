const { app, request, getAdminToken, registerUser } = require('./setup');
const db = require('../src/database');

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const ORDER = {
  recipientName: '優惠碼測試收件人',
  recipientEmail: 'coupon-test@example.com',
  recipientAddress: '台北市優惠碼路 1 號',
  shippingMethod: 'home_delivery',
  isRemoteArea: false,
  isExpress: false,
};

let adminToken;
let productSequence = 0;

async function createProduct(price, stock = 10) {
  productSequence += 1;
  const res = await request(app)
    .post('/api/admin/products')
    .set(auth(adminToken))
    .send({ name: `優惠碼測試商品 ${productSequence}`, price, stock });
  expect(res.status).toBe(201);
  return res.body.data;
}

// A new member whose cart holds one line per [price, quantity] pair
async function memberWithCart(lines) {
  const { token, user } = await registerUser();
  const products = [];

  for (const [price, quantity] of lines) {
    const product = await createProduct(price);
    const res = await request(app)
      .post('/api/cart')
      .set(auth(token))
      .send({ productId: product.id, quantity });
    expect(res.status).toBe(200);
    products.push(product);
  }

  return { token, user, products };
}

function placeOrder(token, extra = {}) {
  return request(app)
    .post('/api/orders')
    .set(auth(token))
    .send({ ...ORDER, ...extra });
}

// Everything a rejected order must leave alone
function snapshot(user, products) {
  return {
    orders: db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(user.id).n,
    stocks: products.map(p => db.prepare('SELECT stock FROM products WHERE id = ?').get(p.id).stock),
    cart: db.prepare(
      'SELECT product_id, quantity FROM cart_items WHERE user_id = ? ORDER BY product_id'
    ).all(user.id),
  };
}

beforeAll(async () => {
  adminToken = await getAdminToken();
});

describe('Order coupons: amounts', () => {
  it('records the coupon and the discount on the order', async () => {
    const { token, user, products } = await memberWithCart([[800, 1]]);

    const res = await placeOrder(token, { couponCode: 'FLOWER100' });

    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    expect(res.body.data).toMatchObject({
      subtotal: 800,
      discount: 100,
      shipping_fee: 120,
      total_amount: 820,
      coupon_code: 'FLOWER100',
      status: 'pending',
    });

    const stored = db.prepare('SELECT * FROM orders WHERE id = ?').get(res.body.data.id);
    expect(stored).toMatchObject({
      subtotal: 800,
      discount: 100,
      shipping_fee: 120,
      total_amount: 820,
      coupon_code: 'FLOWER100',
    });

    // The order was really placed: stock deducted, cart emptied
    expect(snapshot(user, products)).toMatchObject({ orders: 1, stocks: [9], cart: [] });
  });

  it('returns the coupon and the discount from the order detail, the order list and the admin API', async () => {
    const { token } = await memberWithCart([[1000, 1]]);
    const created = await placeOrder(token, { couponCode: 'SPRING10' });
    expect(created.status).toBe(201);
    const orderId = created.body.data.id;
    const expected = { coupon_code: 'SPRING10', discount: 100, total_amount: 1020 };

    const detail = await request(app).get(`/api/orders/${orderId}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject(expected);

    const list = await request(app).get('/api/orders').set(auth(token));
    expect(list.body.data.orders).toHaveLength(1);
    expect(list.body.data.orders[0]).toMatchObject(expected);

    const adminDetail = await request(app).get(`/api/admin/orders/${orderId}`).set(auth(adminToken));
    expect(adminDetail.status).toBe(200);
    expect(adminDetail.body.data).toMatchObject(expected);
  });

  it('stores the code in upper case whatever case or spacing was sent', async () => {
    const { token } = await memberWithCart([[800, 1]]);

    const res = await placeOrder(token, { couponCode: '  flower100 ' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ coupon_code: 'FLOWER100', discount: 100 });
  });

  it('reports a zero discount and no code when no coupon is used', async () => {
    const { token } = await memberWithCart([[800, 1]]);

    const res = await placeOrder(token);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      subtotal: 800,
      discount: 0,
      shipping_fee: 120,
      total_amount: 920,
      coupon_code: null,
    });

    const detail = await request(app).get(`/api/orders/${res.body.data.id}`).set(auth(token));
    expect(detail.body.data).toMatchObject({ discount: 0, coupon_code: null, total_amount: 920 });
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['blank spaces', '   '],
  ])('treats %s as no coupon', async (_label, couponCode) => {
    const { token } = await memberWithCart([[800, 1]]);

    const res = await placeOrder(token, { couponCode });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ discount: 0, coupon_code: null, total_amount: 920 });
  });

  it('applies the coupon to the whole cart subtotal', async () => {
    const { token } = await memberWithCart([[450, 2], [300, 1]]);

    const res = await placeOrder(token, { couponCode: 'SPRING10' });

    // 450 x 2 + 300 = 1200; 10% = 120; below 1,500 after the discount, so 120 shipping
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      subtotal: 1200,
      discount: 120,
      shipping_fee: 120,
      total_amount: 1200,
    });
  });

  it('ignores a discount or total sent by the client', async () => {
    const { token } = await memberWithCart([[800, 1]]);

    const res = await placeOrder(token, {
      discount: 9999,
      totalAmount: 1,
      total_amount: 1,
      coupon_code: 'SPRING10',
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ discount: 0, coupon_code: null, total_amount: 920 });
  });
});

describe('Order coupons: shipping', () => {
  it.each([
    // [subtotal, coupon, method, extras, expected shipping fee, expected total]
    ['1,550 becomes 1,450 after the discount, so home delivery is charged', 1550, 'FLOWER100', 'home_delivery', {}, 120, 1570],
    ['1,600 becomes exactly 1,500, which is free shipping', 1600, 'FLOWER100', 'home_delivery', {}, 0, 1500],
    ['the discounted subtotal also decides convenience-store shipping', 1550, 'FLOWER100', 'convenience_store', {}, 60, 1510],
    ['free shipping never waives the surcharges', 1600, 'FLOWER100', 'home_delivery', { isRemoteArea: true, isExpress: true }, 450, 1950],
    ['a discount is not applied to the surcharges', 1000, 'SPRING10', 'home_delivery', { isRemoteArea: true, isExpress: true }, 570, 1470],
    ['an order without a coupon keeps the original rule', 1500, undefined, 'home_delivery', {}, 0, 1500],
  ])('%s', async (_label, subtotal, couponCode, shippingMethod, extras, shippingFee, total) => {
    const { token } = await memberWithCart([[subtotal, 1]]);

    const res = await placeOrder(token, { couponCode, shippingMethod, ...extras });

    expect(res.status).toBe(201);
    expect(res.body.data.subtotal).toBe(subtotal);
    expect(res.body.data.shipping_fee).toBe(shippingFee);
    expect(res.body.data.total_amount).toBe(total);
  });
});

describe('Order coupons: rejected codes', () => {
  it.each([
    ['an unknown code', 'NOT-A-COUPON', 1000, 'COUPON_INVALID'],
    ['a prototype property name', 'constructor', 1000, 'COUPON_INVALID'],
    ['__proto__', '__proto__', 1000, 'COUPON_INVALID'],
    ['an expired code', 'SUMMER50', 1000, 'COUPON_EXPIRED'],
    ['a subtotal below the minimum', 'FLOWER100', 799, 'COUPON_MIN_SUBTOTAL'],
  ])('answers 400 for %s and leaves orders, stock and cart untouched', async (_label, couponCode, subtotal, errorCode) => {
    const { token, user, products } = await memberWithCart([[subtotal, 1]]);
    const before = snapshot(user, products);

    const res = await placeOrder(token, { couponCode });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ data: null, error: errorCode });
    expect(res.body.message).toEqual(expect.any(String));
    if (errorCode === 'COUPON_INVALID') {
      // Unknown codes are not echoed back; messages for known codes name the canonical code
      expect(res.body.message).not.toContain(couponCode);
    }
    expect(snapshot(user, products)).toEqual(before);
    expect(before.orders).toBe(0);
  });

  it.each([
    ['a number', 123],
    ['an array (only one coupon per order)', ['FLOWER100', 'SPRING10']],
    ['an object', { code: 'FLOWER100' }],
    ['a boolean', true],
  ])('answers VALIDATION_ERROR when the code is %s', async (_label, couponCode) => {
    const { token, user, products } = await memberWithCart([[1000, 1]]);
    const before = snapshot(user, products);

    const res = await placeOrder(token, { couponCode });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ data: null, error: 'VALIDATION_ERROR' });
    expect(snapshot(user, products)).toEqual(before);
  });

  it('reports an empty cart before looking at the coupon', async () => {
    const { token } = await registerUser();

    const res = await placeOrder(token, { couponCode: 'FLOWER100' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ data: null, error: 'CART_EMPTY' });
  });
});
