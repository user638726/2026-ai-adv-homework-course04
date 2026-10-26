const path = require('path');
const { app, request } = require('./setup');
// Only used to point the view engine somewhere else for the render-failure case;
// requests still go through the supertest server from ./setup.
const expressApp = require('../app');

describe('Page routes', () => {
  it.each(['/', '/cart', '/checkout', '/login', '/orders', '/admin/products', '/admin/orders'])(
    'renders %s',
    async (url) => {
      const res = await request(app).get(url);

      expect(res.status).toBe(200);
      expect(res.type).toBe('text/html');
    }
  );

  it.each(['success', 'failed', 'cancel', 'pending'])(
    'passes the known payment result "%s" to the order page',
    async (result) => {
      const res = await request(app).get(`/orders/some-id?payment=${result}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain(`data-payment-result="${result}"`);
    }
  );

  it.each([
    ['an unknown value', 'unknown'],
    ['markup', '<script>alert(1)</script>']
  ])('drops %s from the payment result', async (_label, value) => {
    const res = await request(app).get('/orders/some-id').query({ payment: value });

    expect(res.status).toBe(200);
    expect(res.text).toContain('data-payment-result=""');
    expect(res.text).not.toContain('alert(1)');
  });

  it('does not crash or leak server paths when the query holds an object', async () => {
    const res = await request(app).get('/orders/some-id?payment[toString]=1');

    expect(res.status).toBe(200);
    expect(res.text).toContain('data-payment-result=""');
    expect(res.text).not.toContain(path.resolve(__dirname, '..'));
  });

  it('reports render failures through the error handler without leaking details', async () => {
    const originalViews = expressApp.get('views');
    expressApp.set('views', '/nonexistent-views-directory');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await request(app).get('/cart');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ data: null, error: 'INTERNAL_ERROR', message: '伺服器內部錯誤' });
      expect(res.text).not.toContain('nonexistent-views-directory');
    } finally {
      expressApp.set('views', originalViews);
      vi.restoreAllMocks();
    }
  });
});
