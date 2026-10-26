const { app, request, getAdminToken, registerUser } = require('./setup');

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const SHIPPING = {
  recipientName: '列表測試收件人',
  recipientEmail: 'order-list@example.com',
  recipientAddress: '台北市列表路 1 號',
  shippingMethod: 'home_delivery',
  isRemoteArea: false,
  isExpress: false,
};

describe('GET /api/orders: status filter and pagination', () => {
  let productId;

  beforeAll(async () => {
    const adminToken = await getAdminToken();
    const res = await request(app)
      .post('/api/admin/products')
      .set(auth(adminToken))
      .send({ name: '訂單列表測試商品', price: 100, stock: 1000 });
    expect(res.status).toBe(201);
    productId = res.body.data.id;
  });

  // Places `count` orders one after another and returns them in creation order
  async function placeOrders(token, count) {
    const orders = [];
    for (let i = 0; i < count; i++) {
      const cart = await request(app).post('/api/cart').set(auth(token)).send({ productId, quantity: 1 });
      expect(cart.status).toBe(200);
      const res = await request(app).post('/api/orders').set(auth(token)).send(SHIPPING);
      expect(res.status).toBe(201);
      orders.push(res.body.data);
    }
    return orders;
  }

  async function setPayment(token, orderId, action) {
    const res = await request(app).patch(`/api/orders/${orderId}/pay`).set(auth(token)).send({ action });
    expect(res.status).toBe(200);
  }

  const listOrders = (token, query = '') => request(app).get(`/api/orders${query}`).set(auth(token));

  const ids = (res) => res.body.data.orders.map((order) => order.id);

  it('requires authentication', async () => {
    const res = await request(app).get('/api/orders?status=paid');

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'UNAUTHORIZED');
  });

  it('answers 200 with an empty page for a member without orders', async () => {
    const { token } = await registerUser();

    const res = await listOrders(token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { orders: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } },
      error: null,
      message: '成功',
    });
  });

  describe('with 12 orders', () => {
    let token;
    let created;

    beforeAll(async () => {
      token = (await registerUser()).token;
      created = await placeOrders(token, 12);
    });

    it('returns page 1 with 10 orders by default, in the shape of the admin list', async () => {
      const res = await listOrders(token);

      expect(res.status).toBe(200);
      expect(res.body.error).toBeNull();
      expect(res.body.message).toBe('成功');
      expect(res.body.data.orders).toHaveLength(10);
      expect(res.body.data.pagination).toEqual({ page: 1, limit: 10, total: 12, totalPages: 2 });
    });

    it('keeps the fields of each order unchanged', async () => {
      const res = await listOrders(token, '?limit=1');

      expect(Object.keys(res.body.data.orders[0]).sort()).toEqual([
        'coupon_code',
        'created_at',
        'discount',
        'id',
        'is_express',
        'is_remote_area',
        'order_no',
        'shipping_fee',
        'shipping_method',
        'status',
        'subtotal',
        'total_amount',
      ]);
    });

    it('lists the newest order first, even when orders share the same second', async () => {
      const res = await listOrders(token, '?limit=50');

      expect(ids(res)).toEqual(created.map((order) => order.id).reverse());
    });

    it('splits the list across pages without gaps or duplicates', async () => {
      const pages = [];
      for (const page of [1, 2, 3]) {
        const res = await listOrders(token, `?page=${page}&limit=5`);
        expect(res.status).toBe(200);
        pages.push(ids(res));
      }

      expect(pages.map((page) => page.length)).toEqual([5, 5, 2]);
      expect(pages.flat()).toEqual(created.map((order) => order.id).reverse());
    });

    it('reports 3 total pages and 2 orders on the last page for limit=5', async () => {
      const res = await listOrders(token, '?page=3&limit=5');

      expect(res.body.data.orders).toHaveLength(2);
      expect(res.body.data.pagination).toEqual({ page: 3, limit: 5, total: 12, totalPages: 3 });
    });

    it('answers 200 with no orders for a page past the end, still reporting the totals', async () => {
      const res = await listOrders(token, '?page=4&limit=5');

      expect(res.status).toBe(200);
      expect(res.body.data.orders).toEqual([]);
      expect(res.body.data.pagination).toEqual({ page: 4, limit: 5, total: 12, totalPages: 3 });
    });

    it.each([
      ['100', 50],
      ['51', 50],
      ['50', 50],
      ['49', 49],
      ['99999999999999999999', 50],
    ])('turns limit=%s into %i', async (limit, expected) => {
      const res = await listOrders(token, `?limit=${limit}`);

      expect(res.status).toBe(200);
      expect(res.body.data.pagination.limit).toBe(expected);
    });

    it('returns everything on one page when the limit is large enough', async () => {
      const res = await listOrders(token, '?limit=50');

      expect(res.body.data.orders).toHaveLength(12);
      expect(res.body.data.pagination).toEqual({ page: 1, limit: 50, total: 12, totalPages: 1 });
    });
  });

  describe('status filter', () => {
    let token;
    let created;

    beforeAll(async () => {
      token = (await registerUser()).token;
      created = await placeOrders(token, 6);
      await setPayment(token, created[1].id, 'success');
      await setPayment(token, created[3].id, 'success');
      await setPayment(token, created[4].id, 'success');
      await setPayment(token, created[2].id, 'fail');
    });

    it.each([
      ['paid', [4, 3, 1]],
      ['failed', [2]],
      ['pending', [5, 0]],
    ])('status=%s returns only those orders, newest first', async (status, indexes) => {
      const res = await listOrders(token, `?status=${status}`);

      expect(res.status).toBe(200);
      expect(ids(res)).toEqual(indexes.map((index) => created[index].id));
      expect(res.body.data.orders.every((order) => order.status === status)).toBe(true);
      expect(res.body.data.pagination.total).toBe(indexes.length);
    });

    it('paginates within the filtered list', async () => {
      const first = await listOrders(token, '?status=paid&limit=2&page=1');
      const second = await listOrders(token, '?status=paid&limit=2&page=2');

      expect(ids(first)).toEqual([created[4].id, created[3].id]);
      expect(ids(second)).toEqual([created[1].id]);
      expect(second.body.data.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    });

    it('returns an empty list, not an error, when nothing matches the status', async () => {
      const other = (await registerUser()).token;
      await placeOrders(other, 1);

      const res = await listOrders(other, '?status=paid');

      expect(res.status).toBe(200);
      expect(res.body.data.orders).toEqual([]);
      expect(res.body.data.pagination).toEqual({ page: 1, limit: 10, total: 0, totalPages: 0 });
    });

    it('does not filter when status is not sent', async () => {
      const res = await listOrders(token);

      expect(res.body.data.pagination.total).toBe(6);
    });
  });

  describe('isolation between members', () => {
    it("never returns, counts or filters in another member's orders", async () => {
      const mine = (await registerUser()).token;
      const others = (await registerUser()).token;
      const myOrders = await placeOrders(mine, 2);
      const otherOrders = await placeOrders(others, 3);
      await setPayment(others, otherOrders[0].id, 'success');
      await setPayment(mine, myOrders[0].id, 'success');

      const all = await listOrders(mine, '?limit=50');
      expect(ids(all).sort()).toEqual(myOrders.map((order) => order.id).sort());
      expect(all.body.data.pagination.total).toBe(2);

      const paid = await listOrders(mine, '?status=paid');
      expect(ids(paid)).toEqual([myOrders[0].id]);
      expect(paid.body.data.pagination.total).toBe(1);

      const pageTwo = await listOrders(mine, '?limit=1&page=2');
      expect(ids(pageTwo)).toEqual([myOrders[0].id]);
      expect(pageTwo.body.data.pagination.total).toBe(2);
    });
  });

  describe('invalid query', () => {
    let token;

    beforeAll(async () => {
      token = (await registerUser()).token;
      await placeOrders(token, 1);
    });

    it.each([
      ['an unknown status', '?status=unknown'],
      ['a status in the wrong case', '?status=PAID'],
      ['an empty status', '?status='],
      ['a status with surrounding spaces', '?status=%20paid'],
      ['a repeated status', '?status=paid&status=pending'],
      ['a nested status', '?status[x]=paid'],
      ['page=0', '?page=0'],
      ['a negative page', '?page=-1'],
      ['a decimal page', '?page=1.5'],
      ['a non-numeric page', '?page=abc'],
      ['an empty page', '?page='],
      ['a page in exponent notation', '?page=1e3'],
      ['a repeated page', '?page=1&page=2'],
      ['a nested page', '?page[x]=1'],
      ['limit=0', '?limit=0'],
      ['a negative limit', '?limit=-1'],
      ['a decimal limit', '?limit=2.5'],
      ['a non-numeric limit', '?limit=abc'],
      ['an empty limit', '?limit='],
      ['a repeated limit', '?limit=5&limit=10'],
      ['a valid status with an invalid page', '?status=paid&page=0'],
      ['a valid page with an invalid status', '?page=1&status=nope'],
    ])('answers 400 VALIDATION_ERROR for %s', async (_label, query) => {
      const res = await listOrders(token, query);

      expect(res.status).toBe(400);
      expect(res.body.data).toBeNull();
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message.length).toBeGreaterThan(0);
    });

    it('does not echo the rejected value back', async () => {
      const res = await listOrders(token, '?status=%3Cscript%3Ealert(1)%3C/script%3E');

      expect(res.status).toBe(400);
      expect(res.text).not.toContain('alert(1)');
    });
  });
});
