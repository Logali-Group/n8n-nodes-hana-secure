import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readCursorValue } from '../nodes/HanaSecure/pagination';

describe('keyset pagination cursor', () => {
	it('finds a HANA result column without depending on identifier casing', () => {
		assert.equal(readCursorValue({ CHANGED_AT: '2026-08-20' }, 'changed_at'), '2026-08-20');
	});

	it('fails closed when the cursor is missing or empty', () => {
		assert.throws(() => readCursorValue({ ID: 1 }, 'CHANGED_AT'), /missing/);
		assert.throws(() => readCursorValue({ CHANGED_AT: null }, 'CHANGED_AT'), /empty/);
	});
});
