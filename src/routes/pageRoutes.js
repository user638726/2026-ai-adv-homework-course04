const express = require('express');
const { buildAioFormHtml } = require('../utils/ecpay');
const { findOrderById, getOrderItemSummaries } = require('../services/orderService');
const router = express.Router();

// The ?payment= values the order page knows how to show; anything else is dropped
const PAYMENT_RESULTS = ['success', 'failed', 'cancel', 'pending'];

// Render failures go to the error handler, so template paths and source never reach the browser

// Helper to render with front layout
function renderFront(res, next, page, locals = {}) {
  res.render('pages/' + page, { layout: 'front', ...locals }, function (err, body) {
    if (err) return next(err);
    res.render('layouts/front', { body, ...locals });
  });
}

// Helper to render with admin layout
function renderAdmin(res, next, page, locals = {}) {
  res.render('pages/admin/' + page, locals, function (err, body) {
    if (err) return next(err);
    res.render('layouts/admin', { body, ...locals });
  });
}

// Front pages
router.get('/', function (req, res, next) {
  renderFront(res, next, 'index', { title: '首頁', pageScript: 'index' });
});

router.get('/products/:id', function (req, res, next) {
  renderFront(res, next, 'product-detail', {
    title: '商品詳情',
    pageScript: 'product-detail',
    productId: req.params.id
  });
});

router.get('/cart', function (req, res, next) {
  renderFront(res, next, 'cart', { title: '購物車', pageScript: 'cart' });
});

router.get('/checkout', function (req, res, next) {
  renderFront(res, next, 'checkout', { title: '結帳', pageScript: 'checkout' });
});

router.get('/login', function (req, res, next) {
  renderFront(res, next, 'login', { title: '登入', pageScript: 'login' });
});

router.get('/orders', function (req, res, next) {
  renderFront(res, next, 'orders', { title: '我的訂單', pageScript: 'orders' });
});

router.get('/orders/:id', function (req, res, next) {
  renderFront(res, next, 'order-detail', {
    title: '訂單詳情',
    pageScript: 'order-detail',
    orderId: req.params.id,
    paymentResult: PAYMENT_RESULTS.includes(req.query.payment) ? req.query.payment : ''
  });
});

// ECPay payment form page
router.get('/ecpay/payment/:orderId', function (req, res) {
  const order = findOrderById(req.params.orderId);
  if (!order) {
    return res.status(404).send('訂單不存在');
  }
  if (order.status !== 'pending') {
    return res.redirect('/orders/' + order.id);
  }
  if (!order.merchant_trade_no) {
    return res.status(400).send('此訂單無綠界交易編號');
  }
  const items = getOrderItemSummaries(order.id);
  const html = buildAioFormHtml(order, items);
  res.type('text/html').send(html);
});

// Admin pages
router.get('/admin/products', function (req, res, next) {
  renderAdmin(res, next, 'products', {
    title: '商品管理',
    pageScript: 'admin-products',
    currentPath: '/admin/products'
  });
});

router.get('/admin/orders', function (req, res, next) {
  renderAdmin(res, next, 'orders', {
    title: '訂單管理',
    pageScript: 'admin-orders',
    currentPath: '/admin/orders'
  });
});

module.exports = router;
