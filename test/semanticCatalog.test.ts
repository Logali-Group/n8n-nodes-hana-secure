import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IExecuteFunctions } from 'n8n-workflow';

import { executeCatalogOperation } from '../nodes/HanaSecure/HanaSecure.node';
import type { HanaSession } from '../nodes/HanaSecure/hanaClient';
import type { HanaCredentials } from '../nodes/HanaSecure/types';

const credentials: HanaCredentials = {
	host: 'hana.example.invalid',
	port: 30015,
	user: 'demo',
	password: 'not-used',
	useTLS: true,
	rejectUnauthorized: true,
	allowAdvancedSql: false,
	connectionTimeout: 1000,
	queryTimeout: 1000,
	allowedSchemas: 'SAPHANADB',
};

function catalogContext(objectName: string): IExecuteFunctions {
	return {
		getNodeParameter(name: string, _itemIndex: number, fallback?: unknown) {
			if (name === 'schema') return 'SAPHANADB';
			if (name === 'objectName') return objectName;
			if (name === 'objectType') return 'auto';
			return fallback;
		},
	} as unknown as IExecuteFunctions;
}

function sessionWithSequence(sequence: Record<string, unknown>[][]): HanaSession {
	let index = 0;
	return {
		query: async () => sequence[index++] ?? [],
	};
}

describe('semantic catalog recognition', () => {
	it('recognizes a parameterized ABAP CDS runtime exposed as a table function', async () => {
		const rows = await executeCatalogOperation(
			catalogContext('ZN8NCOUNTRYP'),
			sessionWithSequence([
				[],
				[],
				[
					{
						SCHEMA_NAME: 'SAPHANADB',
						FUNCTION_NAME: 'ZN8NCOUNTRYP',
						INPUT_PARAMETER_COUNT: 1,
						SQL_SECURITY: 'DEFINER',
					},
				],
			]),
			0,
			'inspectSemanticView',
			credentials,
		);

		assert.equal(rows[0].SEMANTIC_KIND, 'HANA_TABLE_FUNCTION_OR_PARAMETERIZED_ABAP_CDS');
		assert.equal(rows[0].REQUIRES_PARAMETERS, true);
		assert.equal(rows[0].INVOCATION_MODE, 'TABLE_FUNCTION_POSITIONAL');
	});

	it('lists ordered table-function inputs as semantic parameters', async () => {
		const rows = await executeCatalogOperation(
			catalogContext('ZN8NCOUNTRYP'),
			sessionWithSequence([
				[],
				[],
				[{ FUNCTION_NAME: 'ZN8NCOUNTRYP', INPUT_PARAMETER_COUNT: 1 }],
				[
					{
						PARAMETER_NAME: 'P_COUNTRY',
						DATA_TYPE_NAME: 'NVARCHAR',
						POSITION: 1,
						PARAMETER_TYPE: 'IN',
					},
				],
				[],
			]),
			0,
			'listSemanticParameters',
			credentials,
		);

		assert.equal(rows[0].PARAMETER_NAME, 'P_COUNTRY');
		assert.equal(rows[0].BINDING_MODE, 'TABLE_FUNCTION_POSITIONAL');
		assert.deepEqual(rows[0]._hana, {
			operation: 'listSemanticParameters',
			rowCount: 1,
			rowLimit: 20,
			truncated: false,
			semanticKind: 'HANA_TABLE_FUNCTION_OR_PARAMETERIZED_ABAP_CDS',
			hasParameters: true,
		});
	});
});
