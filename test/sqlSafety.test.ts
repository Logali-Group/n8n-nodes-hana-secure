import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	assertIdentifier,
	assertSchemaAllowed,
	buildOrderByClause,
	buildWhereClause,
	parseAllowedSchemas,
	parseIdentifierList,
	parseParametersJson,
	quoteIdentifier,
	validateAdvancedSelect,
} from '../nodes/HanaSecure/sqlSafety';

describe('identifier safety', () => {
	it('quotes valid HANA identifiers', () => {
		assert.equal(quoteIdentifier('Company_Code'), '"Company_Code"');
		assert.equal(assertIdentifier('_SYS_BIC'), '_SYS_BIC');
	});

	it('rejects identifiers that could change SQL structure', () => {
		for (const value of ['A.B', 'A B', 'A"; DROP TABLE X', '1TABLE', '']) {
			assert.throws(() => assertIdentifier(value), /Invalid identifier/);
		}
	});

	it('parses unique comma-separated identifiers', () => {
		assert.deepEqual(parseIdentifierList('A, B, A', 'column'), ['A', 'B']);
	});
});

describe('schema allowlist', () => {
	it('normalizes allowed schemas and permits case-insensitive matches', () => {
		const allowlist = parseAllowedSchemas('training, Reporting');
		assert.deepEqual(allowlist, ['TRAINING', 'REPORTING']);
		assert.equal(assertSchemaAllowed('Training', allowlist), 'Training');
	});

	it('blocks schemas outside the allowlist', () => {
		assert.throws(
			() => assertSchemaAllowed('SYSTEM', ['TRAINING']),
			/not allowed by these credentials/,
		);
	});
});

describe('structured query builders', () => {
	it('binds values instead of interpolating them', () => {
		const result = buildWhereClause([
			{ column: 'COMPANY_CODE', operator: 'eq', value: "1010' OR 1=1 --" },
			{ column: 'AMOUNT', operator: 'ge', value: 100 },
			{ column: 'DELETED_AT', operator: 'isNull' },
		]);
		assert.equal(
			result.sql,
			' WHERE "COMPANY_CODE" = ? AND "AMOUNT" >= ? AND "DELETED_AT" IS NULL',
		);
		assert.deepEqual(result.parameters, ["1010' OR 1=1 --", 100]);
	});

	it('builds a validated sort list', () => {
		assert.equal(
			buildOrderByClause([
				{ column: 'FISCAL_YEAR', direction: 'DESC' },
				{ column: 'DOCUMENT', direction: 'ASC' },
			]),
			' ORDER BY "FISCAL_YEAR" DESC, "DOCUMENT" ASC',
		);
	});
});

describe('advanced SQL guard', () => {
	it('accepts a parameterized SELECT and appends the enforced limit', () => {
		assert.equal(
			validateAdvancedSelect(
				'SELECT "UPDATE", "AMOUNT" FROM "TRAINING"."ITEMS" WHERE "COMPANY" = ?',
				['1010'],
				100,
			),
			'SELECT "UPDATE", "AMOUNT" FROM "TRAINING"."ITEMS" WHERE "COMPANY" = ? LIMIT 101',
		);
	});

	it('ignores question marks and keywords inside string literals', () => {
		assert.equal(
			validateAdvancedSelect(
				"SELECT 'UPDATE ? -- harmless text' AS \"TEXT\" FROM DUMMY WHERE 'x' = ?",
				['x'],
				10,
			),
			"SELECT 'UPDATE ? -- harmless text' AS \"TEXT\" FROM DUMMY WHERE 'x' = ? LIMIT 11",
		);
	});

	it('rejects non-SELECT statements, comments, chains, and caller limits', () => {
		for (const sql of [
			'DELETE FROM "T"',
			'SELECT * FROM "T"; DROP TABLE "T"',
			'SELECT * FROM "T" -- bypass',
			'SELECT * FROM "T" /* bypass */',
			'SELECT TOP 10 * FROM "T"',
			'SELECT * FROM "T" LIMIT 10',
			'SELECT * FROM "T" UNION ALL CALL "P"()',
		]) {
			assert.throws(() => validateAdvancedSelect(sql, [], 10));
		}
	});

	it('requires one primitive parameter for each placeholder', () => {
		assert.throws(
			() => validateAdvancedSelect('SELECT * FROM "T" WHERE "A" = ?', [], 10),
			/placeholder/,
		);
		assert.deepEqual(parseParametersJson('["1010", 2026, true, null]'), [
			'1010',
			2026,
			true,
			null,
		]);
		assert.throws(() => parseParametersJson('[{"unsafe":true}]'), /only strings/);
	});
});
