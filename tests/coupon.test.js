const {
  COUPON_ERRORS,
  CouponError,
  normalizeCouponCode,
  applyCoupon
} = require('../src/utils/coupon');

function catchError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

function expectCouponError(fn, code) {
  const error = catchError(fn);

  expect(error).toBeInstanceOf(CouponError);
  expect(error.code).toBe(code);
  expect(error.message).toEqual(expect.any(String));
  return error;
}

describe('Coupon module', () => {
  describe('未使用優惠碼', () => {
    it.each([
      ['未提供', undefined],
      ['null', null],
      ['空字串', ''],
      ['只有空白', '   \t\n']
    ])('%s：沒有折扣，金額不變', (_label, couponCode) => {
      expect(applyCoupon({ subtotal: 1000, couponCode })).toEqual({
        couponCode: null,
        discount: 0,
        discountedSubtotal: 1000
      });
    });
  });

  describe('FLOWER100：折抵 100 元，商品小計滿 800 元', () => {
    it.each([
      [800, 700],
      [801, 701],
      [1600, 1500]
    ])('小計 %i 元可使用，折扣後 %i 元', (subtotal, discountedSubtotal) => {
      expect(applyCoupon({ subtotal, couponCode: 'FLOWER100' })).toEqual({
        couponCode: 'FLOWER100',
        discount: 100,
        discountedSubtotal
      });
    });

    it.each([[799], [1], [0]])('小計 %i 元未達門檻', (subtotal) => {
      const error = expectCouponError(
        () => applyCoupon({ subtotal, couponCode: 'FLOWER100' }),
        COUPON_ERRORS.MIN_SUBTOTAL
      );

      expect(error.message).toContain('FLOWER100');
      expect(error.message).toContain('800');
    });
  });

  describe('SPRING10：打 9 折、四捨五入、最多折抵 300 元', () => {
    it.each([
      // [商品小計, 折扣]：括號內為未四捨五入的 10%
      [1, 0], // 0.1
      [4, 0], // 0.4
      [5, 1], // 0.5 進位
      [14, 1], // 1.4
      [15, 2], // 1.5 進位
      [100, 10],
      [1000, 100],
      [1234, 123], // 123.4
      [1235, 124], // 123.5 進位
      [2994, 299], // 299.4
      [2995, 300], // 299.5 進位
      [3000, 300],
      [3004, 300], // 300.4
      [3005, 300], // 300.5 → 301，超過上限
      [3500, 300],
      [100000, 300]
    ])('小計 %i 元折抵 %i 元', (subtotal, discount) => {
      expect(applyCoupon({ subtotal, couponCode: 'SPRING10' })).toEqual({
        couponCode: 'SPRING10',
        discount,
        discountedSubtotal: subtotal - discount
      });
    });
  });

  describe('SUMMER50：已失效', () => {
    it.each([[1], [800], [1000], [100000]])('小計 %i 元仍不可使用', (subtotal) => {
      const error = expectCouponError(
        () => applyCoupon({ subtotal, couponCode: 'SUMMER50' }),
        COUPON_ERRORS.EXPIRED
      );

      expect(error.message).toContain('SUMMER50');
    });
  });

  describe('優惠碼格式', () => {
    it.each([
      ['全小寫', 'flower100'],
      ['大小寫混合', 'fLoWeR100'],
      ['前後有空白', '  FLOWER100  '],
      ['前後有換行與 tab', '\tFLOWER100\n']
    ])('%s也能使用，並記錄為大寫', (_label, couponCode) => {
      expect(applyCoupon({ subtotal: 800, couponCode })).toMatchObject({
        couponCode: 'FLOWER100',
        discount: 100
      });
    });

    it.each([
      ['不存在的優惠碼', 'NOT-A-COUPON'],
      ['差一個字元', 'FLOWER101'],
      ['中間有空白', 'FLOWER 100'],
      ['原型鏈上的屬性 constructor', 'constructor'],
      ['原型鏈上的屬性 __proto__', '__proto__'],
      ['原型鏈上的屬性 toString', 'toString'],
      ['原型鏈上的屬性 hasOwnProperty', 'hasOwnProperty'],
      ['長 s（ſ）經 toUpperCase 會變成 S', 'ſpring10'],
      ['連字（ﬂ）經 toUpperCase 會變成 FL', 'ﬂower100'],
      ['全形字元', 'ＦＬＯＷＥＲ１００'],
      ['含標籤字元', '<script>alert(1)</script>'],
      ['超過 32 字元', 'A'.repeat(33)],
      ['很長的字串', 'A'.repeat(100000)]
    ])('%s：視為不存在的優惠碼', (_label, couponCode) => {
      expectCouponError(
        () => applyCoupon({ subtotal: 5000, couponCode }),
        COUPON_ERRORS.INVALID
      );
    });

    it('錯誤訊息不回顯使用者輸入的內容', () => {
      const error = expectCouponError(
        () => applyCoupon({ subtotal: 1000, couponCode: '<script>alert(1)</script>' }),
        COUPON_ERRORS.INVALID
      );

      expect(error.message).not.toContain('script');
    });
  });

  describe('輸入驗證', () => {
    it.each([
      ['數字', 123],
      ['陣列', ['FLOWER100']],
      ['物件', { code: 'FLOWER100' }],
      ['布林值', true]
    ])('優惠碼為%s時丟出 TypeError', (_label, couponCode) => {
      expect(() => applyCoupon({ subtotal: 1000, couponCode })).toThrow(TypeError);
      expect(() => normalizeCouponCode(couponCode)).toThrow(TypeError);
    });

    it.each([
      ['負數', -1],
      ['小數', 800.5],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['字串', '800'],
      ['未提供', undefined]
    ])('小計為%s時丟出 TypeError', (_label, subtotal) => {
      expect(() => applyCoupon({ subtotal, couponCode: 'FLOWER100' })).toThrow(TypeError);
    });
  });

  describe('normalizeCouponCode', () => {
    it.each([
      [undefined, null],
      [null, null],
      ['', null],
      ['  ', null],
      ['flower100', 'FLOWER100'],
      [' Spring10 ', 'SPRING10'],
      ['a_b-c', 'A_B-C']
    ])('%j → %j', (input, expected) => {
      expect(normalizeCouponCode(input)).toBe(expected);
    });
  });

  describe('不變量', () => {
    it('折扣一定是介於 0 與小計之間的整數，折扣後小計 = 小計 - 折扣', () => {
      for (const couponCode of ['FLOWER100', 'SPRING10']) {
        for (let subtotal = 800; subtotal <= 6000; subtotal += 1) {
          const result = applyCoupon({ subtotal, couponCode });

          expect(Number.isInteger(result.discount)).toBe(true);
          expect(result.discount).toBeGreaterThanOrEqual(0);
          expect(result.discount).toBeLessThanOrEqual(subtotal);
          expect(result.discountedSubtotal).toBe(subtotal - result.discount);
        }
      }
    });

    it('SPRING10 沒有使用門檻，從 1 元開始都不會超過小計', () => {
      for (let subtotal = 1; subtotal < 800; subtotal += 1) {
        const result = applyCoupon({ subtotal, couponCode: 'SPRING10' });

        expect(result.discount).toBeLessThanOrEqual(subtotal);
        expect(result.discountedSubtotal).toBeGreaterThanOrEqual(0);
      }
    });

    it('回傳結果不可修改', () => {
      expect(Object.isFrozen(applyCoupon({ subtotal: 800, couponCode: 'FLOWER100' }))).toBe(true);
    });
  });
});
