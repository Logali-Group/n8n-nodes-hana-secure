import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	allowedColumnsForObject,
	assertColumnsAllowed,
	assertObjectAllowed,
	parseAllowedObjects,
	parseColumnPolicies,
	parseRequiredFilterPolicies,
	requiredFiltersForObject,
	validateGovernanceConfiguration,
} from '../nodes/HanaSecure/governance';

describe('object governance', () => {
	it('parses exact schema/object allowlists and blocks other objects', () => {
		const allowed = parseAllowedObjects('TRAINING.GL_ITEMS,\nreporting.open_orders');
		assert.equal(allowed.size, 2);
		assert.doesNotThrow(() => assertObjectAllowed('training', 'gl_items', allowed));
		assert.throws(
			() => assertObjectAllowed('TRAINING', 'SECRET_PAYROLL', allowed),
			/not allowed by these credentials/,
		);
	});

	it('rejects malformed object references', () => {
		assert.throws(() => parseAllowedObjects('TRAINING'), /SCHEMA\.OBJECT/);
		assert.throws(() => parseAllowedObjects('TRAINING.GL.ITEMS'), /SCHEMA\.OBJECT/);
	});
});

describe('column and row policies', () => {
	it('applies object-scoped column allowlists case-insensitively', () => {
		const policies = parseColumnPolicies(
			'{"TRAINING.GL_ITEMS":["COMPANY_CODE","AMOUNT","CURRENCY"]}',
		);
		const columns = allowedColumnsForObject('training', 'gl_items', policies);
		assert.deepEqual(columns, ['COMPANY_CODE', 'AMOUNT', 'CURRENCY']);
		assert.doesNotThrow(() => assertColumnsAllowed(['amount'], columns));
		assert.throws(() => assertColumnsAllowed(['SALARY'], columns), /Column\(s\) not allowed/);
	});

	it('parses required filters and rejects unsafe policy shapes', () => {
		const policies = parseRequiredFilterPolicies(
			'{"TRAINING.GL_ITEMS":[{"column":"MANDT","operator":"eq","value":"250"},{"column":"YEAR","operator":"in","value":[2025,2026]}]}',
		);
		assert.deepEqual(requiredFiltersForObject('TRAINING', 'GL_ITEMS', policies), [
			{ column: 'MANDT', operator: 'eq', value: '250' },
			{ column: 'YEAR', operator: 'in', value: [2025, 2026] },
		]);
		assert.throws(
			() =>
				parseRequiredFilterPolicies(
					'{"TRAINING.GL_ITEMS":[{"column":"MANDT OR 1=1","operator":"eq","value":"250"}]}',
				),
			/Invalid required filter column/,
		);
	});

	it('rejects contradictory cross-policy configuration before execution', () => {
		const base = {
			host: 'hana.example.com',
			port: 30015,
			user: 'READ_ONLY',
			password: 'not-a-real-secret',
			useTLS: true,
			rejectUnauthorized: true,
			allowAdvancedSql: false,
			connectionTimeout: 15000,
			queryTimeout: 30000,
		};
		assert.throws(
			() =>
				validateGovernanceConfiguration({
					...base,
					allowedSchemas: 'TRAINING',
					allowedObjects: 'TRAINING.GL_ITEMS',
					columnPoliciesJson: '{"TRAINING.GL_ITEMS":["COMPANY_CODE"]}',
					requiredFiltersJson:
						'{"TRAINING.GL_ITEMS":[{"column":"MANDT","operator":"eq","value":"250"}]}',
				}),
			/Column\(s\) not allowed/,
		);
		assert.throws(
			() =>
				validateGovernanceConfiguration({
					...base,
					allowedSchemas: 'TRAINING',
					allowedObjects: 'REPORTING.OPEN_ORDERS',
				}),
			/outside Allowed Schemas/,
		);
	});
});
