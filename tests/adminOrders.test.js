const { app, request, getAdminToken, registerUser } = require('./setup');

async function createOrderForNewMember() {
  const { token } = await registerUser();
  const prodRes = await request(app).get('/api/products');
  const productId = prodRes.body.data.products[0].id;

  await request(app)
    .post('/api/cart')
    .set('Authorization', `Bearer ${token}`)
    .send({ productId, quantity: 1 });

  const orderRes = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      recipientName: '管理員測試收件人',
      recipientEmail: 'admin-test@example.com',
      recipientAddress: '台北市管理員測試路 456 號',
      shippingMethod: 'home_delivery',
      isRemoteArea: false,
      isExpress: false,
    });

  return { token, orderId: orderRes.body.data.id };
}

describe('Admin Orders API', () => {
  let adminToken;
  let orderId;

  const getOrders = (query = '') => request(app)
    .get(`/api/admin/orders${query}`)
    .set('Authorization', `Bearer ${adminToken}`);

  beforeAll(async () => {
    adminToken = await getAdminToken();
    ({ orderId } = await createOrderForNewMember());
  });

  it('should get admin order list', async () => {
    const res = await getOrders();

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('error', null);
    expect(res.body).toHaveProperty('message');
    expect(res.body.data).toHaveProperty('orders');
    expect(res.body.data).toHaveProperty('pagination');
    expect(Array.isArray(res.body.data.orders)).toBe(true);
    expect(res.body.data.orders.length).toBeGreaterThan(0);
  });

  it('should filter orders by status', async () => {
    const { token, orderId: paidOrderId } = await createOrderForNewMember();
    const payRes = await request(app)
      .patch(`/api/orders/${paidOrderId}/pay`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'success' });
    expect(payRes.status).toBe(200);

    const pending = (await getOrders('?status=pending')).body.data.orders;
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every(order => order.status === 'pending')).toBe(true);
    expect(pending.map(order => order.id)).toContain(orderId);
    expect(pending.map(order => order.id)).not.toContain(paidOrderId);

    const paid = (await getOrders('?status=paid')).body.data.orders;
    expect(paid.map(order => order.id)).toEqual([paidOrderId]);
    expect(paid.every(order => order.status === 'paid')).toBe(true);

    const failed = (await getOrders('?status=failed')).body.data.orders;
    expect(failed).toEqual([]);

    const unknownStatus = (await getOrders('?status=not-a-status')).body.data.orders;
    expect(unknownStatus.map(order => order.id)).toEqual(expect.arrayContaining([orderId, paidOrderId]));
  });

  it('should list the newest order first and paginate without overlap', async () => {
    const { orderId: newestId } = await createOrderForNewMember();

    const first = await getOrders('?page=1&limit=1');
    const second = await getOrders('?page=2&limit=1');

    expect(first.body.data.orders).toHaveLength(1);
    expect(first.body.data.orders[0].id).toBe(newestId);
    expect(second.body.data.orders).toHaveLength(1);
    expect(second.body.data.orders[0].id).not.toBe(newestId);
    expect(first.body.data.pagination).toMatchObject({ page: 1, limit: 1 });
    expect(first.body.data.pagination.total).toBeGreaterThanOrEqual(3);
    expect(first.body.data.pagination.totalPages).toBe(first.body.data.pagination.total);
  });

  it('should fall back to the defaults for invalid pagination values', async () => {
    for (const query of ['limit=0', 'limit=-3', 'limit=2abc', 'page=0', 'page=abc']) {
      const res = await getOrders(`?${query}`);

      expect(res.status).toBe(200);
      expect(res.body.data.pagination).toMatchObject({ page: 1, limit: 10 });
    }
  });

  it('should cap the limit at 100', async () => {
    const res = await getOrders('?limit=500');

    expect(res.status).toBe(200);
    expect(res.body.data.pagination.limit).toBe(100);
  });

  it('should not fail on an oversized page number or object-valued parameters', async () => {
    const oversized = await getOrders('?page=99999999999999999999');
    expect(oversized.status).toBe(200);
    expect(oversized.body.data.orders).toEqual([]);

    for (const query of ['page[toString]=1', 'limit[toString]=1', 'status[toString]=1']) {
      const res = await getOrders(`?${query}`);

      expect(res.status).toBe(200);
      expect(res.body.data.orders.length).toBeGreaterThan(0);
    }
  });

  it('should get admin order detail', async () => {
    const res = await request(app)
      .get(`/api/admin/orders/${orderId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('error', null);
    expect(res.body.data).toHaveProperty('id', orderId);
    expect(res.body.data).toHaveProperty('order_no');
    expect(res.body.data).toHaveProperty('subtotal');
    expect(res.body.data).toHaveProperty('shipping_fee');
    expect(res.body.data).toHaveProperty('shipping_method', 'home_delivery');
    expect(res.body.data.total_amount).toBe(
      res.body.data.subtotal + res.body.data.shipping_fee
    );
    expect(res.body.data).toHaveProperty('items');
    expect(res.body.data).toHaveProperty('user');
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  it('should deny access to regular user', async () => {
    const { token } = await registerUser();
    const res = await request(app)
      .get('/api/admin/orders')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).not.toBeNull();
  });
});
