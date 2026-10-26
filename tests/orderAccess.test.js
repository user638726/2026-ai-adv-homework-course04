const { app, request, getAdminToken, registerUser } = require('./setup');

const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('Order access control', () => {
  let ownerToken;
  let strangerToken;
  let orderId;
  let fetchMock;

  beforeAll(async () => {
    ownerToken = (await registerUser()).token;
    strangerToken = (await registerUser()).token;

    const productsRes = await request(app).get('/api/products');
    const productId = productsRes.body.data.products[0].id;
    await request(app).post('/api/cart').set(auth(ownerToken)).send({ productId, quantity: 1 });

    const orderRes = await request(app)
      .post('/api/orders')
      .set(auth(ownerToken))
      .send({
        recipientName: '訂單擁有者',
        recipientEmail: 'owner-private@example.com',
        recipientAddress: '台北市擁有者專屬路 1 號',
        shippingMethod: 'home_delivery',
        isRemoteArea: false,
        isExpress: false,
      });
    expect(orderRes.status).toBe(201);
    orderId = orderRes.body.data.id;
  });

  beforeEach(() => {
    // A rejected request must never reach ECPay
    fetchMock = vi.fn().mockRejectedValue(new Error('network must not be used'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lets the owner read the order', async () => {
    const res = await request(app).get(`/api/orders/${orderId}`).set(auth(ownerToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('id', orderId);
    expect(res.body.data).toHaveProperty('recipient_email', 'owner-private@example.com');
  });

  it('answers 404 (not 403) when another member reads the order, without leaking its data', async () => {
    const res = await request(app).get(`/api/orders/${orderId}`).set(auth(strangerToken));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ data: null, error: 'NOT_FOUND', message: '訂單不存在' });
    expect(res.text).not.toContain('owner-private@example.com');
  });

  it('requires authentication to read an order', async () => {
    const res = await request(app).get(`/api/orders/${orderId}`);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'UNAUTHORIZED');
  });

  it('does not list the order for another member', async () => {
    const res = await request(app).get('/api/orders').set(auth(strangerToken));

    expect(res.status).toBe(200);
    expect(res.body.data.orders).toEqual([]);
  });

  it('does not let another member change the payment status', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/pay`)
      .set(auth(strangerToken))
      .send({ action: 'success' });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'NOT_FOUND');

    const ownerView = await request(app).get(`/api/orders/${orderId}`).set(auth(ownerToken));
    expect(ownerView.body.data).toHaveProperty('status', 'pending');
  });

  it('does not let another member query ECPay for the order', async () => {
    const res = await request(app)
      .post(`/api/orders/${orderId}/check-payment`)
      .set(auth(strangerToken));

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'NOT_FOUND');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Admin order detail access control', () => {
  let adminToken;
  let memberToken;

  beforeAll(async () => {
    adminToken = await getAdminToken();
    memberToken = (await registerUser()).token;
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/admin/orders/any-order-id');

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'UNAUTHORIZED');
  });

  it('rejects a regular member', async () => {
    const res = await request(app).get('/api/admin/orders/any-order-id').set(auth(memberToken));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ data: null, error: 'FORBIDDEN', message: '權限不足' });
  });

  it('answers 404 to an admin asking for an unknown order', async () => {
    const res = await request(app).get('/api/admin/orders/any-order-id').set(auth(adminToken));

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'NOT_FOUND');
  });
});
