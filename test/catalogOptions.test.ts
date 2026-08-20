import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	loadColumnOptions,
	loadObjectOptions,
	loadSchemaOptions,
	loadTableFunctionColumnOptions,
	loadTableFunctionOptions,
	loadTableFunctionParameterOptions,
} from '../nodes/HanaSecure/catalogOptions';
import type { HanaSession } from '../nodes/HanaSecure/hanaClient';
import type { HanaCredentials } from '../nodes/HanaSecure/types';

const baseCredentials: HanaCredentials = {
	host: 'hana.example.invalid',
	port: 30015,
	user: 'demo',
	password: 'not-used',
	useTLS: true,
	rejectUnauthorized: true,
	allowAdvancedSql: false,
	connectionTimeout: 1000,
	queryTimeout: 1000,
};

function sessionWithRows(rows: Record<string, unknown>[]): HanaSession {
	return { query: async () => rows };
}

describe('dynamic governed catalog options', () => {
	it('filters schema choices through the credential allowlists', async () => {
		const options = await loadSchemaOptions(
			sessionWithRows([{ SCHEMA_NAME: 'TRAINING' }, { SCHEMA_NAME: 'SECRET' }]),
			{ ...baseCredentials, allowedSchemas: 'TRAINING' },
		);
		assert.deepEqual(options, [{ name: 'TRAINING', value: 'TRAINING' }]);
	});

	it('returns only approved objects', async () => {
		const options = await loadObjectOptions(
			sessionWithRows([
				{ OBJECT_NAME: 'GL_ITEMS', OBJECT_TYPE: 'TABLE' },
				{ OBJECT_NAME: 'PAYROLL', OBJECT_TYPE: 'VIEW' },
			]),
			{
				...baseCredentials,
				allowedSchemas: 'TRAINING',
				allowedObjects: 'TRAINING.GL_ITEMS',
			},
			'TRAINING',
		);
		assert.deepEqual(options, [
			{ name: 'GL_ITEMS (table)', value: 'GL_ITEMS', description: 'HANA table' },
		]);
	});

	it('labels virtual tables that may expose remote CDS runtime objects', async () => {
		const options = await loadObjectOptions(
			sessionWithRows([
				{
					OBJECT_NAME: 'REMOTE_ORDERS_P',
					OBJECT_TYPE: 'VIRTUAL_TABLE',
					HAS_PARAMETERS: 'UNKNOWN',
				},
			]),
			{ ...baseCredentials, allowedSchemas: 'TRAINING' },
			'TRAINING',
		);
		assert.deepEqual(options, [
			{
				name: 'REMOTE_ORDERS_P (virtual table)',
				value: 'REMOTE_ORDERS_P',
				description:
					'HANA virtual table; it may expose a remote CDS or parameterized runtime object',
			},
		]);
	});

	it('hides columns outside the object policy', async () => {
		const options = await loadColumnOptions(
			sessionWithRows([
				{ COLUMN_NAME: 'COMPANY_CODE', DATA_TYPE_NAME: 'NVARCHAR', POSITION: 1 },
				{ COLUMN_NAME: 'AMOUNT', DATA_TYPE_NAME: 'DECIMAL', POSITION: 2 },
				{ COLUMN_NAME: 'PRIVATE_NOTE', DATA_TYPE_NAME: 'NVARCHAR', POSITION: 3 },
			]),
			{
				...baseCredentials,
				allowedObjects: 'TRAINING.GL_ITEMS',
				columnPoliciesJson: '{"TRAINING.GL_ITEMS":["COMPANY_CODE","AMOUNT"]}',
			},
			'TRAINING',
			'GL_ITEMS',
		);
		assert.deepEqual(options, [
			{ name: 'COMPANY_CODE (NVARCHAR)', value: 'COMPANY_CODE' },
			{ name: 'AMOUNT (DECIMAL)', value: 'AMOUNT' },
		]);
	});

	it('discovers only governed table functions', async () => {
		const options = await loadTableFunctionOptions(
			sessionWithRows([
				{ FUNCTION_NAME: 'GET_OPEN_ORDERS', INPUT_PARAMETER_COUNT: 2, SQL_SECURITY: 'INVOKER' },
				{ FUNCTION_NAME: 'PRIVATE_PAYROLL', INPUT_PARAMETER_COUNT: 1, SQL_SECURITY: 'DEFINER' },
			]),
			{
				...baseCredentials,
				allowedObjects: 'TRAINING.GET_OPEN_ORDERS',
			},
			'TRAINING',
		);
		assert.deepEqual(options, [
			{
				name: 'GET_OPEN_ORDERS (table function / parameterized CDS)',
				value: 'GET_OPEN_ORDERS',
				description: '2 input parameter(s); SQL security INVOKER',
			},
		]);
	});

	it('prioritizes custom Y and Z functions before the bounded editor result', async () => {
		let query = '';
		await loadTableFunctionOptions(
			{
				query: async (sql) => {
					query = sql;
					return [];
				},
			},
			{ ...baseCredentials, allowedSchemas: 'TRAINING' },
			'TRAINING',
		);
		assert.match(query, /WHEN "FUNCTION_NAME" LIKE 'Z%'/);
		assert.match(query, /WHEN "FUNCTION_NAME" LIKE '\/%'/);
	});

	it('loads table-function inputs and governed output columns', async () => {
		const credentials = {
			...baseCredentials,
			allowedObjects: 'TRAINING.GET_OPEN_ORDERS',
			columnPoliciesJson: '{"TRAINING.GET_OPEN_ORDERS":["ORDER_ID","AMOUNT"]}',
		};
		assert.deepEqual(
			await loadTableFunctionParameterOptions(
				sessionWithRows([
					{ PARAMETER_NAME: 'P_COMPANY_CODE', DATA_TYPE_NAME: 'NVARCHAR', POSITION: 1 },
				]),
				credentials,
				'TRAINING',
				'GET_OPEN_ORDERS',
			),
			[
				{
					name: 'P_COMPANY_CODE (NVARCHAR)',
					value: 'P_COMPANY_CODE',
				},
			],
		);
		assert.deepEqual(
			await loadTableFunctionColumnOptions(
				sessionWithRows([
					{ COLUMN_NAME: 'ORDER_ID', DATA_TYPE_NAME: 'NVARCHAR', POSITION: 1 },
					{ COLUMN_NAME: 'PRIVATE_NOTE', DATA_TYPE_NAME: 'NVARCHAR', POSITION: 2 },
				]),
				credentials,
				'TRAINING',
				'GET_OPEN_ORDERS',
			),
			[{ name: 'ORDER_ID (NVARCHAR)', value: 'ORDER_ID' }],
		);
	});
});
