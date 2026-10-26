const {
  isValidEmail,
  parsePositiveInteger,
  parsePagination,
  parseStrictPagination
} = require('../src/utils/validators');

describe('isValidEmail', () => {
  it.each([
    'user@example.com',
    'user+tag@sub.example.co.uk',
    '用戶@例子.測試'
  ])('accepts %s', (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each([
    ['缺少 @', 'user.example.com'],
    ['網域缺少點', 'user@example'],
    ['含空白字元', 'user name@example.com'],
    ['網域以點結尾', 'user@example.'],
    ['網域含連續的點', 'user@example..com'],
    ['網域以點開頭', 'user@.example.com'],
    ['含兩個 @', 'a@b@example.com'],
    ['數字', 12345],
    ['null', null],
    ['物件', { toString: () => 'a@b.co' }]
  ])('rejects %s', (_label, value) => {
    expect(isValidEmail(value)).toBe(false);
  });

  it('enforces the 254 character limit', () => {
    expect(isValidEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
    expect(isValidEmail(`${'a'.repeat(64)}@${'b'.repeat(60)}.com`)).toBe(true);
  });

  it('rejects pathological input without catastrophic backtracking', () => {
    // The previous pattern needed several seconds for a request body of this shape.
    const inputs = [
      `a@${'.'.repeat(100000)} `,
      `a@${'.'.repeat(250)} `,
      `a@${'a.'.repeat(120)} `
    ];

    const start = process.hrtime.bigint();
    for (const input of inputs) {
      expect(isValidEmail(input)).toBe(false);
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(elapsedMs).toBeLessThan(200);
  });
});

describe('parsePositiveInteger', () => {
  it.each([
    [1, 1],
    [3, 3],
    ['3', 3],
    ['0012', 12],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
  ])('parses %j as %j', (input, expected) => {
    expect(parsePositiveInteger(input)).toBe(expected);
  });

  it.each([
    [0],
    [-1],
    [1.5],
    [0.00390625],
    ['1.5'],
    ['3abc'],
    ['0x1F'],
    [' 5 '],
    [''],
    ['-2'],
    [null],
    [undefined],
    [[5]],
    [{}],
    [true],
    [NaN],
    [Infinity],
    [1e21],
    ['99999999999999999999'],
    [Number.MAX_SAFE_INTEGER + 1]
  ])('rejects %j', (input) => {
    expect(parsePositiveInteger(input)).toBeNull();
  });
});

describe('parsePagination', () => {
  it('uses the defaults for an empty query', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 10, offset: 0 });
  });

  it('reads valid page and limit values', () => {
    expect(parsePagination({ page: '3', limit: '20' })).toEqual({ page: 3, limit: 20, offset: 40 });
  });

  it('caps limit at the maximum', () => {
    expect(parsePagination({ limit: '1000' }).limit).toBe(100);
    expect(parsePagination({ limit: '30' }, { maxLimit: 25 }).limit).toBe(25);
  });

  it('supports a custom default limit', () => {
    expect(parsePagination({}, { defaultLimit: 12 }).limit).toBe(12);
  });

  it.each([
    ['0'],
    ['-3'],
    ['2abc'],
    [''],
    ['1.5'],
    [['1', '2']],
    [{ toString: '1' }],
    [undefined]
  ])('falls back to the default limit for limit=%j', (limit) => {
    expect(parsePagination({ limit }).limit).toBe(10);
  });

  it.each([
    ['0'],
    ['-1'],
    ['abc'],
    [{ toString: '1' }],
    [undefined]
  ])('falls back to page 1 for page=%j', (page) => {
    expect(parsePagination({ page }).page).toBe(1);
  });

  it('caps an absurdly large page instead of overflowing the SQLite offset', () => {
    const { page, offset } = parsePagination({ page: '99999999999999999999', limit: '100' });

    expect(page).toBe(1000000);
    expect(Number.isSafeInteger(offset)).toBe(true);
  });
});

describe('parseStrictPagination', () => {
  it('uses the defaults when page and limit are absent', () => {
    expect(parseStrictPagination({})).toEqual({ page: 1, limit: 10, offset: 0 });
    expect(parseStrictPagination({ page: undefined, limit: undefined })).toEqual({ page: 1, limit: 10, offset: 0 });
  });

  it('reads valid page and limit values', () => {
    expect(parseStrictPagination({ page: '3', limit: '20' })).toEqual({ page: 3, limit: 20, offset: 40 });
  });

  it('accepts leading zeros as the same number', () => {
    expect(parseStrictPagination({ page: '02', limit: '005' })).toEqual({ page: 2, limit: 5, offset: 5 });
  });

  it('caps limit at the maximum instead of rejecting it', () => {
    expect(parseStrictPagination({ limit: '1000' }).limit).toBe(100);
    expect(parseStrictPagination({ limit: '100' }, { maxLimit: 50 }).limit).toBe(50);
    expect(parseStrictPagination({ limit: '51' }, { maxLimit: 50 }).limit).toBe(50);
    expect(parseStrictPagination({ limit: '50' }, { maxLimit: 50 }).limit).toBe(50);
    expect(parseStrictPagination({ limit: '99999999999999999999' }, { maxLimit: 50 }).limit).toBe(50);
  });

  it('supports a custom default limit', () => {
    expect(parseStrictPagination({}, { defaultLimit: 12 }).limit).toBe(12);
  });

  it('caps an absurdly large page instead of overflowing the SQLite offset', () => {
    const { page, offset } = parseStrictPagination({ page: '99999999999999999999', limit: '50' }, { maxLimit: 50 });

    expect(page).toBe(1000000);
    expect(Number.isSafeInteger(offset)).toBe(true);
  });

  it.each([
    ['zero', '0'],
    ['a negative number', '-1'],
    ['a decimal', '1.5'],
    ['text', 'abc'],
    ['trailing text', '2abc'],
    ['an empty string', ''],
    ['exponent notation', '1e3'],
    ['surrounding spaces', ' 1'],
    ['a repeated parameter', ['1', '2']],
    ['a nested object', { x: '1' }],
    ['null', null]
  ])('rejects page when it is %s', (_label, page) => {
    expect(parseStrictPagination({ page })).toBeNull();
  });

  it.each([
    ['zero', '0'],
    ['a negative number', '-1'],
    ['a decimal', '2.5'],
    ['text', 'abc'],
    ['an empty string', ''],
    ['exponent notation', '1e3'],
    ['a repeated parameter', ['5', '10']],
    ['a nested object', { x: '1' }],
    ['null', null]
  ])('rejects limit when it is %s', (_label, limit) => {
    expect(parseStrictPagination({ limit })).toBeNull();
  });

  it('rejects the query when only one of the two values is invalid', () => {
    expect(parseStrictPagination({ page: '2', limit: '0' })).toBeNull();
    expect(parseStrictPagination({ page: '0', limit: '5' })).toBeNull();
  });
});
