import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	buildCompositeKeysetWhere,
	collectKeysetPages,
	cursorOrderBy,
	decodeCursor,
	encodeCursor,
	readCursorValue,
} from '../nodes/HanaSecure/pagination';

describe('keyset pagination cursor', () => {
	it('finds a HANA result column without depending on identifier casing', () => {
		assert.equal(readCursorValue({ CHANGED_AT: '2026-08-20' }, 'changed_at'), '2026-08-20');
	});

	it('fails closed when the cursor is missing or empty', () => {
		assert.throws(() => readCursorValue({ ID: 1 }, 'CHANGED_AT'), /missing/);
		assert.throws(() => readCursorValue({ CHANGED_AT: null }, 'CHANGED_AT'), /empty/);
	});

	it('round-trips an opaque composite cursor without losing types', () => {
		const token = encodeCursor(
			{ CHANGED_AT: '2026-08-20T10:00:00Z', DOCUMENT_ID: 42 },
			['CHANGED_AT', 'DOCUMENT_ID'],
			'ASC',
		);
		assert.deepEqual(decodeCursor(token), {
			version: 1,
			columns: ['CHANGED_AT', 'DOCUMENT_ID'],
			values: ['2026-08-20T10:00:00Z', 42],
			direction: 'ASC',
		});
	});

	it('preserves BIGINT, date, and binary cursor values', () => {
		const token = encodeCursor(
			{
				BIG_ID: 9_007_199_254_740_993n,
				CHANGED_AT: new Date('2026-08-20T10:00:00.000Z'),
				BINARY_ID: Buffer.from([0xde, 0xad]),
			},
			['BIG_ID', 'CHANGED_AT', 'BINARY_ID'],
			'ASC',
		);
		const decoded = decodeCursor(token);
		assert.equal(decoded.values[0], 9_007_199_254_740_993n);
		assert.deepEqual(decoded.values[1], new Date('2026-08-20T10:00:00.000Z'));
		assert.deepEqual(decoded.values[2], Buffer.from([0xde, 0xad]));
	});

	it('builds a stable lexicographic predicate for duplicate leading values', () => {
		const where = buildCompositeKeysetWhere({
			version: 1,
			columns: ['CHANGED_AT', 'DOCUMENT_ID'],
			values: ['2026-08-20T10:00:00Z', 42],
			direction: 'ASC',
		});
		assert.equal(
			where.sql,
			' WHERE ("CHANGED_AT" > ? OR ("CHANGED_AT" = ? AND "DOCUMENT_ID" > ?))',
		);
		assert.deepEqual(where.parameters, ['2026-08-20T10:00:00Z', '2026-08-20T10:00:00Z', 42]);
	});

	it('places every cursor column before additional sorting', () => {
		assert.deepEqual(
			cursorOrderBy(['CHANGED_AT', 'DOCUMENT_ID'], 'DESC', [
				{ column: 'DOCUMENT_ID', direction: 'ASC' },
				{ column: 'COMPANY_CODE', direction: 'ASC' },
			]),
			[
				{ column: 'CHANGED_AT', direction: 'DESC' },
				{ column: 'DOCUMENT_ID', direction: 'DESC' },
				{ column: 'COMPANY_CODE', direction: 'ASC' },
			],
		);
	});

	it('rejects altered and mismatched cursor tokens', () => {
		assert.throws(() => decodeCursor('not-a-cursor'), /invalid|corrupted/);
		const invalid = Buffer.from(
			JSON.stringify({ version: 1, columns: ['ID'], values: [], direction: 'ASC' }),
		).toString('base64url');
		assert.throws(() => decodeCursor(invalid), /shape/);
	});

	it('automatically follows composite pages without gaps or duplicates', async () => {
		const sourceRows = [
			{ CHANGED_AT: '2026-08-20T10:00:00Z', ID: 1 },
			{ CHANGED_AT: '2026-08-20T10:00:00Z', ID: 2 },
			{ CHANGED_AT: '2026-08-20T10:05:00Z', ID: 3 },
			{ CHANGED_AT: '2026-08-20T10:05:00Z', ID: 4 },
			{ CHANGED_AT: '2026-08-20T10:10:00Z', ID: 5 },
		];
		const result = await collectKeysetPages(
			['CHANGED_AT', 'ID'],
			'ASC',
			2,
			5,
			10,
			undefined,
			async (cursor, limit) => {
				const start = cursor
					? sourceRows.findIndex(
							(row) => row.CHANGED_AT === cursor.values[0] && row.ID === cursor.values[1],
						) + 1
					: 0;
				return sourceRows.slice(start, start + limit + 1);
			},
		);

		assert.deepEqual(
			result.rows.map((row) => row.ID),
			[1, 2, 3, 4, 5],
		);
		assert.equal(result.pagesFetched, 3);
		assert.equal(result.hasMore, false);
	});

	it('returns a continuation token when automatic caps stop the read', async () => {
		const sourceRows = Array.from({ length: 8 }, (_, index) => ({ ID: index + 1 }));
		const result = await collectKeysetPages(
			['ID'],
			'ASC',
			2,
			4,
			10,
			undefined,
			async (cursor, limit) => {
				const start = cursor ? Number(cursor.values[0]) : 0;
				return sourceRows.slice(start, start + limit + 1);
			},
		);

		assert.deepEqual(
			result.rows.map((row) => row.ID),
			[1, 2, 3, 4],
		);
		assert.equal(result.hasMore, true);
		assert.ok(result.nextCursor);
		assert.deepEqual(decodeCursor(result.nextCursor ?? '').values, [4]);
	});
});
