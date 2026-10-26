const { app, request, getAdminToken, registerUser } = require('./setup');

describe('Cart API', () => {
  const sessionId = 'test-session-' + Date.now();
  let productId;
  let cartItemId;
  let userToken;

  beforeAll(async () => {
    // Get a product id from the product list
    const res = await request(app).get('/api/products');
    productId = res.body.data.products[0].id;
  });

  it('should add product to cart (guest mode)', async () => {
    const res = await request(app)
      .post('/api/cart')
      .set('X-Session-Id', sessionId)
      .send({ productId, quantity: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('error', null);
    expect(res.body).toHaveProperty('message');
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data).toHaveProperty('product_id', productId);
    expect(res.body.data).toHaveProperty('quantity', 1);

    cartItemId = res.body.data.id;
  });

  it('should get cart (guest mode)', async () => {
    const res = await request(app)
      .get('/api/cart')
      .set('X-Session-Id', sessionId);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('error', null);
    expect(res.body.data).toHaveProperty('items');
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    const [item] = res.body.data.items;
    expect(item.quantity).toBe(1);
    expect(res.body.data.total).toBe(item.product.price * item.quantity);
  });

  it('should update cart item quantity (guest mode)', async () => {
    const res = await request(app)
      .patch(`/api/cart/${cartItemId}`)
      .set('X-Session-Id', sessionId)
      .send({ quantity: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('error', null);
    expect(res.body.data).toHaveProperty('quantity', 3);
  });

  it('should remove cart item (guest mode)', async () => {
    const res = await request(app)
      .delete(`/api/cart/${cartItemId}`)
      .set('X-Session-Id', sessionId);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('error', null);

    // Verify cart is empty
    const cartRes = await request(app)
      .get('/api/cart')
      .set('X-Session-Id', sessionId);
    expect(cartRes.body.data.items.length).toBe(0);
  });

  it('should add product to cart (authenticated mode)', async () => {
    const { token } = await registerUser();
    userToken = token;

    const res = await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ productId, quantity: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('error', null);
    expect(res.body.data).toHaveProperty('product_id', productId);
  });

  it('should fail to add non-existent product to cart', async () => {
    const res = await request(app)
      .post('/api/cart')
      .set('X-Session-Id', sessionId)
      .send({ productId: 'non-existent-product-id', quantity: 1 });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('data', null);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).not.toBeNull();
  });

  it('should reject non-integer quantity', async () => {
    for (const quantity of [1.9, '3abc', [5]]) {
      const res = await request(app)
        .post('/api/cart')
        .set('X-Session-Id', sessionId)
        .send({ productId, quantity });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('data', null);
      expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
    }
  });

  it('should merge the guest cart into the member cart on login', async () => {
    const guestSessionId = 'merge-login-' + Date.now();
    const email = `merge-${Date.now()}@example.com`;
    const { token } = await registerUser({ email });

    // Member already has 1; as a guest they add 2 more of the same product
    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, quantity: 1 });
    await request(app)
      .post('/api/cart')
      .set('X-Session-Id', guestSessionId)
      .send({ productId, quantity: 2 });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('X-Session-Id', guestSessionId)
      .send({ email, password: 'password123' });
    expect(loginRes.status).toBe(200);

    const memberCart = await request(app)
      .get('/api/cart')
      .set('Authorization', `Bearer ${loginRes.body.data.token}`);
    const merged = memberCart.body.data.items.filter(item => item.product_id === productId);
    expect(merged.length).toBe(1);
    expect(merged[0]).toHaveProperty('quantity', 3);

    const guestCart = await request(app)
      .get('/api/cart')
      .set('X-Session-Id', guestSessionId);
    expect(guestCart.body.data.items.length).toBe(0);
  });

  it('should merge the guest cart on register and cap quantity at stock', async () => {
    const adminToken = await getAdminToken();
    const productRes = await request(app)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '合併測試花束', price: 500, stock: 3 });
    const limitedProductId = productRes.body.data.id;

    const guestSessionId = 'merge-register-' + Date.now();
    await request(app)
      .post('/api/cart')
      .set('X-Session-Id', guestSessionId)
      .send({ productId: limitedProductId, quantity: 3 });

    // Stock drops after the guest added the item
    await request(app)
      .put(`/api/admin/products/${limitedProductId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ stock: 2 });

    const registerRes = await request(app)
      .post('/api/auth/register')
      .set('X-Session-Id', guestSessionId)
      .send({ email: `merge-register-${Date.now()}@example.com`, password: 'password123', name: '合併測試' });
    expect(registerRes.status).toBe(201);

    const memberCart = await request(app)
      .get('/api/cart')
      .set('Authorization', `Bearer ${registerRes.body.data.token}`);
    expect(memberCart.body.data.items.length).toBe(1);
    expect(memberCart.body.data.items[0]).toHaveProperty('product_id', limitedProductId);
    expect(memberCart.body.data.items[0]).toHaveProperty('quantity', 2);
  });
});

describe('Cart quantity validation and ownership', () => {
  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const STOCK = 5;
  let productId;
  let ownerToken;
  let strangerToken;
  let itemId;

  async function setQuantity(quantity) {
    const res = await request(app).patch(`/api/cart/${itemId}`).set(auth(ownerToken)).send({ quantity });
    expect(res.status).toBe(200);
  }

  async function getStoredQuantity() {
    const res = await request(app).get('/api/cart').set(auth(ownerToken));
    return res.body.data.items.find(entry => entry.id === itemId)?.quantity;
  }

  beforeAll(async () => {
    const adminToken = await getAdminToken();
    const productRes = await request(app)
      .post('/api/admin/products')
      .set(auth(adminToken))
      .send({ name: '購物車驗證花束', price: 500, stock: STOCK });
    productId = productRes.body.data.id;

    ownerToken = (await registerUser()).token;
    strangerToken = (await registerUser()).token;

    const addRes = await request(app)
      .post('/api/cart')
      .set(auth(ownerToken))
      .send({ productId, quantity: 1 });
    itemId = addRes.body.data.id;
  });

  afterEach(async () => {
    await setQuantity(1);
  });

  it.each([
    [0],
    [-1],
    [1.5],
    [0.00390625],
    [1e21],
    ['abc'],
    ['1.5'],
    ['0x1F'],
    ['99999999999999999999'],
    [null],
    [''],
    [[2]],
    [true],
    [{}]
  ])('PATCH rejects quantity %j and keeps the stored quantity', async (quantity) => {
    const res = await request(app)
      .patch(`/api/cart/${itemId}`)
      .set(auth(ownerToken))
      .send({ quantity });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ data: null, error: 'VALIDATION_ERROR', message: 'quantity 必須為正整數' });
    expect(await getStoredQuantity()).toBe(1);
  });

  it('PATCH rejects a missing quantity', async () => {
    const res = await request(app).patch(`/api/cart/${itemId}`).set(auth(ownerToken)).send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
  });

  it('PATCH rejects a quantity above the stock', async () => {
    const res = await request(app)
      .patch(`/api/cart/${itemId}`)
      .set(auth(ownerToken))
      .send({ quantity: STOCK + 1 });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'STOCK_INSUFFICIENT');
    expect(await getStoredQuantity()).toBe(1);
  });

  it('PATCH accepts a quantity equal to the stock', async () => {
    const res = await request(app)
      .patch(`/api/cart/${itemId}`)
      .set(auth(ownerToken))
      .send({ quantity: STOCK });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('quantity', STOCK);
    expect(await getStoredQuantity()).toBe(STOCK);
  });

  it('PATCH accepts an integer string, like POST does', async () => {
    const res = await request(app)
      .patch(`/api/cart/${itemId}`)
      .set(auth(ownerToken))
      .send({ quantity: '2' });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('quantity', 2);
  });

  it("PATCH cannot change another member's item", async () => {
    const res = await request(app)
      .patch(`/api/cart/${itemId}`)
      .set(auth(strangerToken))
      .send({ quantity: 3 });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'NOT_FOUND');
    expect(await getStoredQuantity()).toBe(1);
  });

  it("PATCH cannot change a member's item through a guest session", async () => {
    const res = await request(app)
      .patch(`/api/cart/${itemId}`)
      .set('X-Session-Id', 'guest-' + Date.now())
      .send({ quantity: 3 });

    expect(res.status).toBe(404);
    expect(await getStoredQuantity()).toBe(1);
  });

  it('PATCH answers 404 for an unknown item', async () => {
    const res = await request(app)
      .patch('/api/cart/unknown-item-id')
      .set(auth(ownerToken))
      .send({ quantity: 2 });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'NOT_FOUND');
  });

  it('PATCH requires a token or a session id', async () => {
    const res = await request(app).patch(`/api/cart/${itemId}`).send({ quantity: 2 });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'UNAUTHORIZED');
  });

  it('DELETE answers 404 for an unknown item', async () => {
    const res = await request(app).delete('/api/cart/unknown-item-id').set(auth(ownerToken));

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'NOT_FOUND');
  });

  it("DELETE cannot remove another member's item", async () => {
    const res = await request(app).delete(`/api/cart/${itemId}`).set(auth(strangerToken));

    expect(res.status).toBe(404);
    expect(await getStoredQuantity()).toBe(1);
  });

  it('POST adds up the quantity of the same product and checks the sum against the stock', async () => {
    const added = await request(app)
      .post('/api/cart')
      .set(auth(ownerToken))
      .send({ productId, quantity: 2 });

    expect(added.status).toBe(200);
    expect(added.body.data).toMatchObject({ id: itemId, quantity: 3 });

    const tooMany = await request(app)
      .post('/api/cart')
      .set(auth(ownerToken))
      .send({ productId, quantity: 3 });

    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toHaveProperty('error', 'STOCK_INSUFFICIENT');
    expect(await getStoredQuantity()).toBe(3);
  });

  it('GET reports the exact cart total', async () => {
    await setQuantity(4);

    const res = await request(app).get('/api/cart').set(auth(ownerToken));

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(500 * 4);
  });

  it('an invalid bearer token is rejected and does not fall back to the session id', async () => {
    const res = await request(app)
      .get('/api/cart')
      .set('Authorization', 'Bearer not.a.valid.token')
      .set('X-Session-Id', 'guest-' + Date.now());

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'UNAUTHORIZED');
  });
});
