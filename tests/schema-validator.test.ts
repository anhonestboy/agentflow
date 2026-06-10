import { validateJsonSchema } from '../src/schema-validator.js';

describe('validateJsonSchema', () => {
  test('accepts a valid object', () => {
    const schema = {
      type: 'object',
      required: ['name', 'age'],
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
    };
    expect(validateJsonSchema({ name: 'a', age: 3 }, schema)).toEqual([]);
  });

  test('flags a missing required field', () => {
    const schema = { type: 'object', required: ['name'], properties: {} };
    const errs = validateJsonSchema({}, schema);
    expect(errs.join(' ')).toMatch(/missing required field "name"/);
  });

  test('flags a wrong primitive type', () => {
    const schema = { type: 'object', properties: { age: { type: 'integer' } } };
    const errs = validateJsonSchema({ age: 'not-a-number' }, schema);
    expect(errs.join(' ')).toMatch(/expected integer/);
  });

  test('distinguishes integer from float', () => {
    const schema = { type: 'integer' };
    expect(validateJsonSchema(3, schema)).toEqual([]);
    expect(validateJsonSchema(3.5, schema).length).toBeGreaterThan(0);
  });

  test('enforces minimum and maximum on numbers', () => {
    const schema = { type: 'number', minimum: 0, maximum: 1 };
    expect(validateJsonSchema(0.5, schema)).toEqual([]);
    expect(validateJsonSchema(-1, schema).join(' ')).toMatch(/less than minimum/);
    expect(validateJsonSchema(2, schema).join(' ')).toMatch(/greater than maximum/);
  });

  test('enforces minLength and maxLength on strings', () => {
    const schema = { type: 'string', minLength: 2, maxLength: 4 };
    expect(validateJsonSchema('abc', schema)).toEqual([]);
    expect(validateJsonSchema('a', schema).join(' ')).toMatch(/minLength/);
    expect(validateJsonSchema('abcde', schema).join(' ')).toMatch(/maxLength/);
  });

  test('validates nested object properties', () => {
    const schema = {
      type: 'object',
      properties: {
        meta: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    };
    expect(validateJsonSchema({ meta: { id: 'x' } }, schema)).toEqual([]);
    expect(validateJsonSchema({ meta: {} }, schema).join(' ')).toMatch(/missing required/);
  });

  test('flags an array where an object is expected', () => {
    const schema = { type: 'object' };
    expect(validateJsonSchema([], schema).join(' ')).toMatch(/expected object/);
  });
});
