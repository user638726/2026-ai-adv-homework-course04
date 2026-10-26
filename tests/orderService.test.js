const { generateOrderNo, generateUniqueOrderNo } = require('../src/services/orderService');

describe('generateOrderNo', () => {
  it('uses the ORD-YYYYMMDD-XXXXX format', () => {
    expect(generateOrderNo()).toMatch(/^ORD-\d{8}-[A-F0-9]{5}$/);
  });
});

describe('generateUniqueOrderNo', () => {
  it('returns the first candidate that is not taken yet', () => {
    const candidates = ['ORD-20261026-AAAAA', 'ORD-20261026-AAAAA', 'ORD-20261026-BBBBB'];
    const generate = vi.fn(() => candidates.shift());
    const taken = new Set(['ORD-20261026-AAAAA']);

    expect(generateUniqueOrderNo(orderNo => taken.has(orderNo), generate)).toBe('ORD-20261026-BBBBB');
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('does not retry when the first candidate is free', () => {
    const generate = vi.fn(() => 'ORD-20261026-CCCCC');

    expect(generateUniqueOrderNo(() => false, generate)).toBe('ORD-20261026-CCCCC');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('gives up after the maximum number of attempts', () => {
    const generate = vi.fn(() => 'ORD-20261026-AAAAA');

    expect(() => generateUniqueOrderNo(() => true, generate, 3)).toThrow(/unique order number/);
    expect(generate).toHaveBeenCalledTimes(3);
  });
});
