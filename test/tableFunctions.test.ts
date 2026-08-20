import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	buildTableFunctionSource,
	isSupportedScalarFunctionParameter,
	type TableFunctionParameterMetadata,
} from '../nodes/HanaSecure/tableFunctions';

const metadata: TableFunctionParameterMetadata[] = [
	{
		name: 'P_COMPANY_CODE',
		dataTypeName: 'NVARCHAR',
		position: 1,
		parameterType: 'IN',
	},
	{ name: 'P_MIN_AMOUNT', dataTypeName: 'DECIMAL', position: 2, parameterType: 'IN' },
];

describe('HANA table-function sources', () => {
	it('binds named UI inputs in catalog position order', () => {
		assert.deepEqual(
			buildTableFunctionSource(
				'TRAINING',
				'GET_OPEN_ORDERS',
				[
					{ name: 'p_min_amount', value: '250.50', valueType: 'number' },
					{ name: 'P_COMPANY_CODE', value: '1010', valueType: 'string' },
				],
				metadata,
			),
			{
				sql: '"TRAINING"."GET_OPEN_ORDERS"(?, ?)',
				parameters: ['1010', 250.5],
			},
		);
	});

	it('supports a zero-input table function', () => {
		assert.deepEqual(buildTableFunctionSource('TRAINING', 'CURRENT_RATES', [], []), {
			sql: '"TRAINING"."CURRENT_RATES"()',
			parameters: [],
		});
	});

	it('binds an explicit null without embedding it in SQL', () => {
		assert.deepEqual(
			buildTableFunctionSource(
				'TRAINING',
				'OPTIONAL_FILTER',
				[{ name: 'P_VALUE', value: 'ignored', valueType: 'null' }],
				[
					{ name: 'P_VALUE', dataTypeName: 'NVARCHAR', position: 1, parameterType: 'IN' },
				],
			),
			{ sql: '"TRAINING"."OPTIONAL_FILTER"(?)', parameters: [null] },
		);
	});

	it('rejects missing, unknown, and duplicate inputs', () => {
		assert.throws(
			() =>
				buildTableFunctionSource(
					'TRAINING',
					'GET_OPEN_ORDERS',
					[{ name: 'P_COMPANY_CODE', value: '1010' }],
					metadata,
				),
			/Missing table-function input parameter.*P_MIN_AMOUNT/,
		);
		assert.throws(
			() =>
				buildTableFunctionSource(
					'TRAINING',
					'GET_OPEN_ORDERS',
					[
						{ name: 'P_COMPANY_CODE', value: '1010' },
						{ name: 'P_MIN_AMOUNT', value: '1' },
						{ name: 'P_SECRET', value: 'x' },
					],
					metadata,
				),
			/Unknown table-function input parameter.*P_SECRET/,
		);
		assert.throws(
			() =>
				buildTableFunctionSource(
					'TRAINING',
					'GET_OPEN_ORDERS',
					[
						{ name: 'P_COMPANY_CODE', value: '1010' },
						{ name: 'p_company_code', value: '1020' },
					],
					metadata,
				),
			/configured more than once/,
		);
	});

	it('rejects table and array inputs in the guarded invocation path', () => {
		assert.equal(isSupportedScalarFunctionParameter('NVARCHAR'), true);
		assert.equal(isSupportedScalarFunctionParameter('TABLE TYPE'), false);
		assert.equal(isSupportedScalarFunctionParameter('INTEGER ARRAY'), false);
		assert.throws(
			() =>
				buildTableFunctionSource(
					'TRAINING',
					'TABLE_INPUT',
					[{ name: 'P_ROWS', value: '[]' }],
					[
						{ name: 'P_ROWS', dataTypeName: 'TABLE TYPE', position: 1, parameterType: 'IN' },
					],
				),
			/Only scalar inputs are supported/,
		);
	});

	it('rejects unsafe schema or function identifiers', () => {
		assert.throws(
			() => buildTableFunctionSource('TRAINING', 'F() DELETE FROM X', [], []),
			/Invalid identifier/,
		);
	});

	it('rejects more than twenty inputs', () => {
		const tooMany = Array.from({ length: 21 }, (_, index) => ({
			name: `P_${index}`,
			dataTypeName: 'INTEGER',
			position: index,
			parameterType: 'IN',
		}));
		assert.throws(
			() => buildTableFunctionSource('TRAINING', 'TOO_MANY', [], tooMany),
			/at most 20/,
		);
	});
});
