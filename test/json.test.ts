import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { enforceJsonByteLimit, rowsToJson, toJsonCompatible } from '../nodes/HanaSecure/json';

describe('HANA JSON conversion', () => {
	it('uses lossless defaults for big integers, dates, and binary values', () => {
		assert.deepEqual(
			rowsToJson([
				{
					BIG_ID: 9_007_199_254_740_993n,
					CHANGED_AT: new Date('2026-08-20T10:00:00.000Z'),
					PAYLOAD: Buffer.from([0xde, 0xad]),
				},
			]),
			[
				{
					BIG_ID: '9007199254740993',
					CHANGED_AT: '2026-08-20T10:00:00.000Z',
					PAYLOAD: '3q0=',
				},
			],
		);
	});

	it('supports epoch dates and hexadecimal binary output', () => {
		assert.deepEqual(
			toJsonCompatible(
				{ WHEN: new Date('1970-01-01T00:00:01.000Z'), DATA: Buffer.from([0xde, 0xad]) },
				{ dateMode: 'epochMilliseconds', binaryEncoding: 'hex' },
			),
			{ WHEN: 1000, DATA: 'dead' },
		);
	});

	it('fails rather than rounding an unsafe integer requested as a number', () => {
		assert.throws(
			() => toJsonCompatible(9_007_199_254_740_993n, { bigIntMode: 'number' }),
			/safe integer range/,
		);
		assert.equal(toJsonCompatible(42n, { bigIntMode: 'number' }), 42);
	});

	it('enforces a serialized result-size cap', () => {
		const rows = [{ VALUE: 'x'.repeat(1500) }];
		assert.ok(enforceJsonByteLimit(rows, 2048) > 1500);
		assert.throws(() => enforceJsonByteLimit(rows, 1024), /above the configured limit/);
	});
});
