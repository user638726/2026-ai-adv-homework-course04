const { createApp, ref, onMounted } = Vue;

createApp({
  setup() {
    if (!Auth.requireAuth()) return {};

    const orders = ref([]);
    const pagination = ref({ page: 1, limit: 10, total: 0, totalPages: 0 });
    const loading = ref(true);

    const statusMap = {
      pending: { label: '待付款', cls: 'bg-apricot/20 text-apricot' },
      paid: { label: '已付款', cls: 'bg-sage/20 text-sage' },
      failed: { label: '付款失敗', cls: 'bg-red-100 text-red-600' },
    };

    async function loadOrders(page) {
      loading.value = true;
      try {
        const res = await apiFetch('/api/orders?page=' + (page || 1));
        orders.value = res.data.orders;
        pagination.value = res.data.pagination;
      } catch (e) {
        orders.value = [];
      } finally {
        loading.value = false;
      }
    }

    onMounted(function () {
      loadOrders(1);
    });

    return { orders, pagination, loading, statusMap, formatDate, loadOrders };
  }
}).mount('#app');
