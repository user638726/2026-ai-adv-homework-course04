const { app, request } = require('./setup');

describe('Products API', () => {
  let productId;

  it('should get product list', async () => {
    const res = await request(app).get('/api/products');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('error', null);
    expect(res.body).toHaveProperty('message');
    expect(res.body.data).toHaveProperty('products');
    expect(res.body.data).toHaveProperty('pagination');
    expect(Array.isArray(res.body.data.products)).toBe(true);
    expect(res.body.data.products.length).toBeGreaterThan(0);

    productId = res.body.data.products[0].id;
  });

  it('should support pagination', async () => {
    const res = await request(app).get('/api/products?page=1&limit=2');

    expect(res.status).toBe(200);
    expect(res.body.data.pagination.page).toBe(1);
    expect(res.body.data.pagination.limit).toBe(2);
    expect(res.body.data.products.length).toBeLessThanOrEqual(2);
  });

  it('should get product detail by id', async () => {
    const res = await request(app).get(`/api/products/${productId}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('error', null);
    expect(res.body.data).toHaveProperty('id', productId);
    expect(res.body.data).toHaveProperty('name');
    expect(res.body.data).toHaveProperty('price');
    expect(res.body.data).toHaveProperty('stock');
  });

  it('should return 404 for non-existent product', async () => {
    const res = await request(app).get('/api/products/non-existent-id');

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('data', null);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).not.toBeNull();
  });

  it('should fall back to the defaults for invalid pagination values', async () => {
    for (const query of ['page=0&limit=0', 'page=-1&limit=-3', 'page=abc&limit=2abc', 'page=1.5&limit=1.5']) {
      const res = await request(app).get(`/api/products?${query}`);

      expect(res.status).toBe(200);
      expect(res.body.data.pagination).toMatchObject({ page: 1, limit: 10 });
    }
  });

  it('should cap the limit at 100', async () => {
    const res = await request(app).get('/api/products?limit=1000');

    expect(res.status).toBe(200);
    expect(res.body.data.pagination.limit).toBe(100);
  });

  it('should not fail on an oversized page number', async () => {
    const res = await request(app).get('/api/products?page=99999999999999999999');

    expect(res.status).toBe(200);
    expect(res.body.data.products).toEqual([]);
    expect(res.body.data.pagination.total).toBeGreaterThan(0);
  });

  it('should not fail when pagination parameters are objects or arrays', async () => {
    for (const query of ['page[toString]=1', 'limit[toString]=1', 'page=1&page=2', 'limit[]=5']) {
      const res = await request(app).get(`/api/products?${query}`);

      expect(res.status).toBe(200);
      expect(res.body.data.pagination).toMatchObject({ page: 1, limit: 10 });
    }
  });
});
