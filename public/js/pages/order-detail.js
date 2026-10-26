const { createApp, ref, computed, onMounted } = Vue;

createApp({
  setup() {
    if (!Auth.requireAuth()) return {};

    const el = document.getElementById('app');
    const orderId = el.dataset.orderId;
    const paymentResult = ref(el.dataset.paymentResult || null);

    const order = ref(null);
    const loading = ref(true);
    const paying = ref(false);

    const statusMap = {
      pending: { label: '待付款', cls: 'bg-apricot/20 text-apricot' },
      paid: { label: '已付款', cls: 'bg-sage/20 text-sage' },
      failed: { label: '付款失敗', cls: 'bg-red-100 text-red-600' },
    };

    const paymentMessages = {
      success: { text: '付款成功！感謝您的購買。', cls: 'bg-sage/10 text-sage border border-sage/20' },
      failed: { text: '付款失敗，請重試。', cls: 'bg-red-50 text-red-600 border border-red-100' },
      cancel: { text: '付款已取消。', cls: 'bg-apricot/10 text-apricot border border-apricot/20' },
      pending: { text: '付款處理中，請點擊「查詢付款狀態」確認結果。', cls: 'bg-apricot/10 text-apricot border border-apricot/20' },
    };

    // The URL only says what the visitor was told. A banner that claims a payment outcome
    // must agree with the real order status, otherwise ?payment=success on any order would
    // show "付款成功".
    const requiredStatus = { success: 'paid', failed: 'failed', pending: 'pending' };
    const visiblePaymentResult = computed(() => {
      const result = paymentResult.value;
      if (!result || !paymentMessages[result] || !order.value) return null;
      if (requiredStatus[result] && order.value.status !== requiredStatus[result]) return null;
      return result;
    });

    async function checkPayment() {
      if (!order.value || paying.value) return;
      paying.value = true;
      try {
        const res = await apiFetch('/api/orders/' + order.value.id + '/check-payment', {
          method: 'POST'
        });
        order.value = res.data;
        if (res.data.status === 'paid') {
          paymentResult.value = 'success';
        } else {
          Notification.show(res.message || '尚未完成付款，請稍後再查詢', 'info');
        }
      } catch (e) {
        Notification.show(e?.data?.message || '查詢付款狀態失敗', 'error');
      } finally {
        paying.value = false;
      }
    }

    onMounted(async function () {
      try {
        const res = await apiFetch('/api/orders/' + orderId);
        order.value = res.data;

        if (paymentResult.value === 'pending' && order.value.status === 'pending') {
          await checkPayment();
        }
      } catch (e) {
        Notification.show('載入訂單失敗', 'error');
      } finally {
        loading.value = false;
      }
    });

    return {
      order, loading, paying, paymentResult, visiblePaymentResult,
      statusMap, paymentMessages, checkPayment, formatDate
    };
  }
}).mount('#app');
