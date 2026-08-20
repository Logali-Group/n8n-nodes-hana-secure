import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSemanticSource } from '../nodes/HanaSecure/semanticViews';

describe('semantic and CDS runtime view sources', () => {
	it('builds a regular governed table or view source', () => {
		assert.deepEqual(buildSemanticSource('TRAINING', 'I_GLITEM', 'none', []), {
			sql: '"TRAINING"."I_GLITEM"',
			parameters: [],
		});
	});

	it('binds positional parameters for SQL and virtual CDS runtime views', () => {
		assert.deepEqual(
			buildSemanticSource('TRAINING', 'ZC_GLITEM', 'sqlPositional', [
				{ value: '1010' },
				{ value: '2026', valueType: 'number' },
			]),
			{
				sql: '"TRAINING"."ZC_GLITEM"(?, ?)',
				parameters: ['1010', 2026],
			},
		);
	});

	it('uses validated named placeholders for calculation views', () => {
		assert.deepEqual(
			buildSemanticSource('TRAINING', 'CV_MARGIN', 'calculationPlaceholders', [
				{ name: 'P_COMPANY_CODE', value: '1010' },
				{ name: 'P_YEAR', value: '2026', valueType: 'number' },
			]),
			{
				sql: '"TRAINING"."CV_MARGIN"(PLACEHOLDER."$$P_COMPANY_CODE$$" => ?, PLACEHOLDER."$$P_YEAR$$" => ?)',
				parameters: ['1010', 2026],
			},
		);
	});

	it('rejects unsafe and duplicate placeholder names', () => {
		assert.throws(
			() =>
				buildSemanticSource('TRAINING', 'CV_MARGIN', 'calculationPlaceholders', [
					{ name: 'P_YEAR")', value: '2026' },
				]),
			/Invalid calculation view parameter/,
		);
		assert.throws(
			() =>
				buildSemanticSource('TRAINING', 'CV_MARGIN', 'calculationPlaceholders', [
					{ name: 'P_YEAR', value: '2026' },
					{ name: 'p_year', value: '2027' },
				]),
			/must be unique/,
		);
	});
});
