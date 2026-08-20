import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatHanaOutput } from '../nodes/HanaSecure/output';

describe('HANA output modes', () => {
	const inputItem = { json: { requestId: 'REQ-1001' } };
	const rows = [{ COMPANY_CODE: '1010' }, { COMPANY_CODE: '1020' }];

	it('returns one n8n item per row by default', () => {
		assert.deepEqual(formatHanaOutput(inputItem, rows, 3, 'eachRow', 'hanaRows'), [
			{ json: rows[0], pairedItem: { item: 3 } },
			{ json: rows[1], pairedItem: { item: 3 } },
		]);
	});

	it('can wrap all bounded rows in one item', () => {
		assert.deepEqual(formatHanaOutput(inputItem, rows, 0, 'singleItem', 'companies'), [
			{
				json: { companies: rows, rowCount: 2 },
				pairedItem: { item: 0 },
			},
		]);
	});

	it('can preserve the input item and add the HANA result', () => {
		assert.deepEqual(formatHanaOutput(inputItem, rows, 0, 'addToInput', 'hanaRows'), [
			{
				json: { requestId: 'REQ-1001', hanaRows: rows },
				pairedItem: { item: 0 },
			},
		]);
	});

	it('rejects unsafe result field names', () => {
		assert.throws(
			() => formatHanaOutput(inputItem, rows, 0, 'singleItem', '__proto__'),
			/reserved/,
		);
		assert.throws(
			() => formatHanaOutput(inputItem, rows, 0, 'singleItem', 'rows.value'),
			/must start/,
		);
	});
});
