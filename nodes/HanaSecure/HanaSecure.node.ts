import {
	NodeConnectionTypes,
	NodeOperationError,
	OperationalError,
	type ICredentialDataDecryptedObject,
	type ICredentialTestFunctions,
	type ICredentialsDecrypted,
	type IDataObject,
	type IExecuteFunctions,
	type INodeCredentialTestResult,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import { withHanaClient, type HanaSession } from './hanaClient';
import {
	allowedObjectNamesForSchema,
	allowedColumnsForObject,
	assertColumnsAllowed,
	assertObjectAllowed,
	hasStructuredGovernance,
	isObjectAllowed,
	parseAllowedObjects,
	parseColumnPolicies,
	parseRequiredFilterPolicies,
	requiredFiltersForObject,
	validateGovernanceConfiguration,
} from './governance';
import { rowsToJson } from './json';
import { readCursorValue } from './pagination';
import {
	assertIdentifier,
	assertSchemaAllowed,
	buildOrderByClause,
	buildWhereClause,
	combineWhereClauses,
	normalizeUiFilters,
	parseAllowedSchemas,
	parseIdentifierList,
	parseParametersJson,
	parseTypedValue,
	quoteIdentifier,
	validateAdvancedSelect,
} from './sqlSafety';
import type { FilterLogic, FilterValueType, HanaCredentials, OrderBy, UiFilter } from './types';
import { enforceAiToolByteLimit, resolveAiToolPolicy } from './toolPolicy';

const MAX_ROW_LIMIT = 1000;

function rowLimit(value: number, policyMaximum = MAX_ROW_LIMIT): number {
	if (!Number.isInteger(value) || value < 1 || value > MAX_ROW_LIMIT) {
		throw new OperationalError(`Row limit must be an integer between 1 and ${MAX_ROW_LIMIT}.`);
	}
	return Math.min(value, policyMaximum);
}

function valuesFromCollection<T>(value: unknown): T[] {
	if (!value || typeof value !== 'object') return [];
	const values = (value as { values?: T[] }).values;
	return Array.isArray(values) ? values : [];
}

function addResultMetadata(
	rows: Record<string, unknown>[],
	operation: string,
	limit: number,
	includeMetadata: boolean,
	extra: Record<string, unknown> = {},
): Record<string, unknown>[] {
	const truncated = rows.length > limit;
	const limitedRows = rows.slice(0, limit);
	if (!includeMetadata) return limitedRows;

	const metadata = {
		operation,
		rowCount: limitedRows.length,
		rowLimit: limit,
		truncated,
		...extra,
	};
	if (limitedRows.length === 0) return [{ _hana: metadata }];
	return limitedRows.map((row, index) => (index === 0 ? { ...row, _hana: metadata } : row));
}

async function executeCatalogOperation(
	context: IExecuteFunctions,
	session: HanaSession,
	itemIndex: number,
	operation: string,
	credentials: HanaCredentials,
	aiToolMaxRows?: number,
): Promise<Record<string, unknown>[]> {
	const allowlist = parseAllowedSchemas(credentials.allowedSchemas);
	const allowedObjects = parseAllowedObjects(credentials.allowedObjects);
	const columnPolicies = parseColumnPolicies(credentials.columnPoliciesJson);

	if (operation === 'listSchemas') {
		const rows = await session.query(
			`SELECT "SCHEMA_NAME" FROM "SYS"."SCHEMAS" WHERE "SCHEMA_NAME" <> 'SYS' AND "SCHEMA_NAME" NOT LIKE '\\_SYS\\_%' ESCAPE '\\' ORDER BY "SCHEMA_NAME"`,
		);
		let visibleRows =
			allowlist.length === 0
				? rows
				: rows.filter((row) => allowlist.includes(String(row.SCHEMA_NAME).toUpperCase()));
		if (allowedObjects.size > 0) {
			visibleRows = visibleRows.filter((row) => {
				const prefix = `${String(row.SCHEMA_NAME).toUpperCase()}.`;
				return [...allowedObjects].some((reference) => reference.startsWith(prefix));
			});
		}
		return aiToolMaxRows === undefined
			? visibleRows
			: addResultMetadata(visibleRows, operation, aiToolMaxRows, true);
	}

	const schema = assertSchemaAllowed(
		context.getNodeParameter('schema', itemIndex) as string,
		allowlist,
	);
	if (operation === 'listObjects') {
		const prefix = context.getNodeParameter('objectNamePrefix', itemIndex, '') as string;
		const limit = rowLimit(
			context.getNodeParameter('catalogLimit', itemIndex, 100) as number,
			aiToolMaxRows,
		);
		const escapedPrefix = prefix.replace(/[\\%_]/g, '\\$&');
		const governedNames = allowedObjectNamesForSchema(schema, allowedObjects);
		if (governedNames?.length === 0) {
			return addResultMetadata([], operation, limit, true, {
				objectAllowlistApplied: true,
			});
		}
		const objectPredicate = governedNames
			? ` AND "TABLE_NAME" IN (${governedNames.map(() => '?').join(', ')})`
			: '';
		const viewPredicate = governedNames
			? ` AND "VIEW_NAME" IN (${governedNames.map(() => '?').join(', ')})`
			: '';
		const queryParameters = governedNames
			? [
					schema,
					`${escapedPrefix}%`,
					...governedNames,
					schema,
					`${escapedPrefix}%`,
					...governedNames,
				]
			: [schema, `${escapedPrefix}%`, schema, `${escapedPrefix}%`];
		const rows = await session.query(
			`SELECT "SCHEMA_NAME", "TABLE_NAME" AS "OBJECT_NAME", 'TABLE' AS "OBJECT_TYPE"
FROM "SYS"."TABLES" WHERE "SCHEMA_NAME" = ? AND "TABLE_NAME" LIKE ? ESCAPE '\\'${objectPredicate}
UNION ALL
SELECT "SCHEMA_NAME", "VIEW_NAME" AS "OBJECT_NAME", 'VIEW' AS "OBJECT_TYPE"
FROM "SYS"."VIEWS" WHERE "SCHEMA_NAME" = ? AND "VIEW_NAME" LIKE ? ESCAPE '\\'${viewPredicate}
ORDER BY "OBJECT_TYPE", "OBJECT_NAME"
LIMIT ${limit + 1}`,
			queryParameters,
		);
		const governedRows = rows.filter((row) =>
			isObjectAllowed(schema, String(row.OBJECT_NAME), allowedObjects),
		);
		return addResultMetadata(governedRows, operation, limit, true, {
			objectAllowlistApplied: allowedObjects.size > 0,
		});
	}

	const objectType = context.getNodeParameter('objectType', itemIndex) as 'table' | 'view';
	const objectName = assertIdentifier(
		context.getNodeParameter('objectName', itemIndex) as string,
		'object name',
	);
	assertObjectAllowed(schema, objectName, allowedObjects);
	const catalogView = objectType === 'view' ? 'VIEW_COLUMNS' : 'TABLE_COLUMNS';
	const objectColumn = objectType === 'view' ? 'VIEW_NAME' : 'TABLE_NAME';
	let rows: Record<string, unknown>[];
	try {
		rows = await session.query(
			`SELECT "COLUMN_NAME", "POSITION", "DATA_TYPE_NAME", "LENGTH", "SCALE", "IS_NULLABLE", "DEFAULT_VALUE", "COMMENTS"
FROM "SYS"."${catalogView}"
WHERE "SCHEMA_NAME" = ? AND "${objectColumn}" = ?
ORDER BY "POSITION"`,
			[schema, objectName],
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/invalid column name/i.test(message)) {
			// Converted to NodeOperationError by the execute boundary, which has node context.
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
			throw new OperationalError(message);
		}
		rows = await session.query(
			`SELECT "COLUMN_NAME", "POSITION", "DATA_TYPE_NAME", "LENGTH", "SCALE", "IS_NULLABLE"
FROM "SYS"."${catalogView}"
WHERE "SCHEMA_NAME" = ? AND "${objectColumn}" = ?
ORDER BY "POSITION"`,
			[schema, objectName],
		);
	}
	const allowedColumns = allowedColumnsForObject(schema, objectName, columnPolicies);
	if (allowedColumns) {
		const allowed = new Set(allowedColumns.map((column) => column.toUpperCase()));
		rows = rows.filter((row) => allowed.has(String(row.COLUMN_NAME).toUpperCase()));
	}
	return aiToolMaxRows === undefined
		? rows
		: addResultMetadata(rows, operation, aiToolMaxRows, true);
}

async function executeRowsOperation(
	context: IExecuteFunctions,
	session: HanaSession,
	itemIndex: number,
	operation: string,
	credentials: HanaCredentials,
	aiToolMaxRows?: number,
): Promise<Record<string, unknown>[]> {
	const allowlist = parseAllowedSchemas(credentials.allowedSchemas);
	const allowedObjects = parseAllowedObjects(credentials.allowedObjects);
	const columnPolicies = parseColumnPolicies(credentials.columnPoliciesJson);
	const requiredFilterPolicies = parseRequiredFilterPolicies(credentials.requiredFiltersJson);
	const schema = assertSchemaAllowed(
		context.getNodeParameter('schema', itemIndex) as string,
		allowlist,
	);
	const objectName = assertIdentifier(
		context.getNodeParameter('objectName', itemIndex) as string,
		'object name',
	);
	assertObjectAllowed(schema, objectName, allowedObjects);
	const allowedColumns = allowedColumnsForObject(schema, objectName, columnPolicies);
	const filters = normalizeUiFilters(
		valuesFromCollection<UiFilter>(context.getNodeParameter('filters', itemIndex, {})),
	);
	const filterLogic = context.getNodeParameter('filterLogic', itemIndex, 'AND') as FilterLogic;
	const requiredFilters = requiredFiltersForObject(schema, objectName, requiredFilterPolicies);
	assertColumnsAllowed(
		[...filters, ...requiredFilters].map((filter) => filter.column),
		allowedColumns,
	);
	const userWhere = buildWhereClause(filters, filterLogic);
	const requiredWhere = buildWhereClause(requiredFilters, 'AND');
	const limit = rowLimit(context.getNodeParameter('limit', itemIndex) as number, aiToolMaxRows);
	const tableReference = `${quoteIdentifier(schema)}.${quoteIdentifier(objectName)}`;
	const policyMetadata = {
		source: `${schema}.${objectName}`,
		objectAllowlistApplied: allowedObjects.size > 0,
		columnPolicyApplied: allowedColumns !== undefined,
		requiredFilterCount: requiredFilters.length,
	};

	if (operation === 'select') {
		const rawColumns = context.getNodeParameter('columns', itemIndex) as string;
		const selectedColumns =
			rawColumns.trim() === '*' ? allowedColumns : parseIdentifierList(rawColumns, 'column');
		if (selectedColumns) assertColumnsAllowed(selectedColumns, allowedColumns);
		const columns = selectedColumns
			? selectedColumns.map((column) => quoteIdentifier(column)).join(', ')
			: '*';
		let orderBy = valuesFromCollection<OrderBy>(context.getNodeParameter('orderBy', itemIndex, {}));
		assertColumnsAllowed(
			orderBy.map((sort) => sort.column),
			allowedColumns,
		);

		const paginationMode = context.getNodeParameter('paginationMode', itemIndex, 'none') as string;
		let cursorColumn: string | undefined;
		let cursorDirection: 'ASC' | 'DESC' = 'ASC';
		let cursorWhere = { sql: '', parameters: [] as unknown[] };
		if (paginationMode !== 'none') {
			cursorColumn = assertIdentifier(
				context.getNodeParameter('cursorColumn', itemIndex) as string,
				'cursor column',
			);
			assertColumnsAllowed([cursorColumn], allowedColumns);
			if (
				selectedColumns &&
				!selectedColumns.some((column) => column.toUpperCase() === cursorColumn?.toUpperCase())
			) {
				throw new OperationalError('The cursor column must be included in the selected columns.');
			}
			cursorDirection = context.getNodeParameter('cursorDirection', itemIndex, 'ASC') as
				| 'ASC'
				| 'DESC';
			if (paginationMode === 'keysetContinue') {
				const cursorValueType = context.getNodeParameter(
					'cursorValueType',
					itemIndex,
					'string',
				) as FilterValueType;
				cursorWhere = buildWhereClause([
					{
						column: cursorColumn,
						operator: cursorDirection === 'DESC' ? 'lt' : 'gt',
						value: parseTypedValue(
							context.getNodeParameter('cursorValue', itemIndex),
							cursorValueType,
						),
					},
				]);
			}
			orderBy = [
				{ column: cursorColumn, direction: cursorDirection },
				...orderBy.filter((sort) => sort.column.toUpperCase() !== cursorColumn?.toUpperCase()),
			];
		}

		const where = combineWhereClauses(requiredWhere, userWhere, cursorWhere);
		const sql = `SELECT ${columns} FROM ${tableReference}${where.sql}${buildOrderByClause(orderBy)} LIMIT ${limit + 1}`;
		const queryStartedAt = Date.now();
		const rows = await session.query(sql, where.parameters);
		const durationMs = Date.now() - queryStartedAt;
		const includeMetadata =
			paginationMode !== 'none' ||
			(context.getNodeParameter('includeMetadata', itemIndex, true) as boolean);
		const limitedRows = rows.slice(0, limit);
		const lastLimitedRow = limitedRows[limitedRows.length - 1];
		const nextCursor =
			cursorColumn && lastLimitedRow && rows.length > limit
				? readCursorValue(lastLimitedRow, cursorColumn)
				: undefined;
		return addResultMetadata(rows, operation, limit, includeMetadata, {
			...policyMetadata,
			durationMs,
			paginationMode,
			hasMore: rows.length > limit,
			...(nextCursor === undefined ? {} : { nextCursor, cursorColumn, cursorDirection }),
		});
	}

	const aggregateFunction = context.getNodeParameter('aggregateFunction', itemIndex) as string;
	const aggregateColumn = context.getNodeParameter('aggregateColumn', itemIndex, '') as string;
	const aggregateAlias = quoteIdentifier(
		context.getNodeParameter('aggregateAlias', itemIndex) as string,
		'aggregate alias',
	);
	const aggregateExpression =
		aggregateFunction === 'COUNT'
			? 'COUNT(*)'
			: aggregateFunction === 'COUNT_DISTINCT'
				? `COUNT(DISTINCT ${quoteIdentifier(aggregateColumn, 'aggregate column')})`
				: `${aggregateFunction}(${quoteIdentifier(aggregateColumn, 'aggregate column')})`;
	const groupByRaw = context.getNodeParameter('groupBy', itemIndex, '') as string;
	const groupByColumns = groupByRaw.trim() ? parseIdentifierList(groupByRaw, 'group column') : [];
	const aggregateColumns = aggregateFunction === 'COUNT' ? [] : [aggregateColumn];
	assertColumnsAllowed([...aggregateColumns, ...groupByColumns], allowedColumns);
	const where = combineWhereClauses(requiredWhere, userWhere);
	const groupSelect = groupByColumns.map((column) => quoteIdentifier(column)).join(', ');
	const groupClause = groupSelect ? ` GROUP BY ${groupSelect}` : '';
	const selectClause = groupSelect
		? `${groupSelect}, ${aggregateExpression} AS ${aggregateAlias}`
		: `${aggregateExpression} AS ${aggregateAlias}`;
	const sql = `SELECT ${selectClause} FROM ${tableReference}${where.sql}${groupClause} LIMIT ${limit + 1}`;
	const queryStartedAt = Date.now();
	const rows = await session.query(sql, where.parameters);
	const durationMs = Date.now() - queryStartedAt;
	const includeMetadata = context.getNodeParameter('includeMetadata', itemIndex, true) as boolean;
	return addResultMetadata(rows, operation, limit, includeMetadata, {
		...policyMetadata,
		durationMs,
	});
}

async function executeAdvancedSql(
	context: IExecuteFunctions,
	session: HanaSession,
	itemIndex: number,
	credentials: HanaCredentials,
): Promise<Record<string, unknown>[]> {
	if (credentials.allowAdvancedSql !== true) {
		throw new OperationalError(
			'Advanced SQL is disabled in the selected credential. Enable it only for trusted workflows.',
		);
	}
	if (context.getNode().typeVersion >= 1.1 && hasStructuredGovernance(credentials)) {
		throw new OperationalError(
			'Advanced SQL cannot be combined with schema, object, column, or required-filter policies. Use structured Row operations, or a separate least-privilege credential with database grants as its only boundary.',
		);
	}
	const limit = rowLimit(context.getNodeParameter('limit', itemIndex) as number);
	const parameters = parseParametersJson(
		context.getNodeParameter('parametersJson', itemIndex, '[]') as string,
	);
	const sql = validateAdvancedSelect(
		context.getNodeParameter('sql', itemIndex) as string,
		parameters,
		limit,
	);
	const rows = await session.query(sql, parameters);
	const includeMetadata = context.getNodeParameter('includeMetadata', itemIndex, true) as boolean;
	return addResultMetadata(rows, 'executeSelect', limit, includeMetadata);
}

export class HanaSecure implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Logali HANA Guard',
		name: 'hanaSecure',
		icon: {
			light: 'file:logaliHanaGuard-v023.svg',
			dark: 'file:logaliHanaGuard-v023.dark.svg',
		},
		group: ['input'],
		version: [1, 1.1],
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Read SAP HANA data with explicit security guardrails by Logali Group',
		usableAsTool: {
			replacements: {
				description:
					'Give an AI agent governed, bounded access to approved SAP HANA reads; advanced SQL is always blocked',
			},
		},
		defaults: { name: 'Logali HANA Guard' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'hanaSecureApi', required: true, testedBy: 'hanaConnectionTest' }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Connection', value: 'connection' },
					{ name: 'Catalog', value: 'catalog' },
					{ name: 'Row', value: 'rows' },
					{ name: 'SQL (Advanced — Workflow Only)', value: 'sql' },
				],
				default: 'connection',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['connection'] } },
				options: [
					{
						name: 'Test Connection',
						value: 'testConnection',
						action: 'Test the HANA connection',
						description: 'Connect and return the active user, schema, and database',
					},
				],
				default: 'testConnection',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['catalog'] } },
				options: [
					{
						name: 'List Schemas',
						value: 'listSchemas',
						action: 'List schemas',
						description: 'List visible schemas, restricted by the credential allowlist',
					},
					{
						name: 'List Tables and Views',
						value: 'listObjects',
						action: 'List tables and views',
						description: 'List tables and views in one allowed schema',
					},
					{
						name: 'Describe Table or View',
						value: 'describeObject',
						action: 'Describe a table or view',
						description: 'Return column metadata from the HANA system catalog',
					},
				],
				default: 'listSchemas',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['rows'] } },
				options: [
					{
						name: 'Select Rows',
						value: 'select',
						action: 'Select rows',
						description: 'Read rows with validated identifiers and bound filter values',
					},
					{
						name: 'Aggregate Rows',
						value: 'aggregate',
						action: 'Aggregate rows',
						description: 'Calculate a grouped or ungrouped aggregate',
					},
				],
				default: 'select',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['sql'] } },
				options: [
					{
						name: 'Execute Read-Only SQL',
						value: 'executeSelect',
						action: 'Execute read only SQL',
						description: 'Execute one guarded SELECT statement with positional parameters',
					},
				],
				default: 'executeSelect',
			},
			{
				displayName: 'Schema',
				name: 'schema',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'TRAINING',
				description: 'Schema containing the table or view',
				displayOptions: {
					show: {
						resource: ['catalog'],
						operation: ['listObjects', 'describeObject'],
					},
				},
			},
			{
				displayName: 'Object Name Prefix',
				name: 'objectNamePrefix',
				type: 'string',
				default: '',
				placeholder: 'ZTRAINING_',
				description:
					'Optional literal prefix used to narrow catalog discovery; wildcard characters are escaped',
				displayOptions: {
					show: { resource: ['catalog'], operation: ['listObjects'] },
				},
			},
			{
				displayName: 'Catalog Result Limit',
				name: 'catalogLimit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: MAX_ROW_LIMIT },
				default: 100,
				description: 'Maximum number of tables and views returned by catalog discovery',
				displayOptions: {
					show: { resource: ['catalog'], operation: ['listObjects'] },
				},
			},
			{
				displayName: 'Schema',
				name: 'schema',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'TRAINING',
				description: 'Schema containing the table or view',
				displayOptions: { show: { resource: ['rows'] } },
			},
			{
				displayName: 'Object Type',
				name: 'objectType',
				type: 'options',
				options: [
					{ name: 'Table', value: 'table' },
					{ name: 'View', value: 'view' },
				],
				default: 'table',
				displayOptions: {
					show: { resource: ['catalog'], operation: ['describeObject'] },
				},
			},
			{
				displayName: 'Table or View Name',
				name: 'objectName',
				type: 'string',
				default: '',
				required: true,
				description: 'Unquoted table or view name',
				displayOptions: {
					show: {
						resource: ['catalog'],
						operation: ['describeObject'],
					},
				},
			},
			{
				displayName: 'Table or View Name',
				name: 'objectName',
				type: 'string',
				default: '',
				required: true,
				description: 'Unquoted table or view name',
				displayOptions: { show: { resource: ['rows'] } },
			},
			{
				displayName: 'Columns',
				name: 'columns',
				type: 'string',
				default: '*',
				description: 'Comma-separated column names, or * for all columns',
				displayOptions: { show: { resource: ['rows'], operation: ['select'] } },
			},
			{
				displayName: 'Filter Logic',
				name: 'filterLogic',
				type: 'options',
				options: [
					{ name: 'All Filters Must Match (AND)', value: 'AND' },
					{ name: 'Any Filter May Match (OR)', value: 'OR' },
				],
				default: 'AND',
				description:
					'How user-defined filters are combined. Credential-required filters are always enforced with AND.',
				displayOptions: { show: { resource: ['rows'] } },
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Filter',
				displayOptions: { show: { resource: ['rows'] } },
				options: [
					{
						displayName: 'Values',
						name: 'values',
						values: [
							{
								displayName: 'Column',
								name: 'column',
								type: 'string',
								default: '',
								required: true,
							},
							{
								displayName: 'Operator',
								name: 'operator',
								type: 'options',
								options: [
									{ name: 'Between', value: 'between' },
									{ name: 'Contains Literal Text', value: 'contains' },
									{ name: 'Ends With Literal Text', value: 'endsWith' },
									{ name: 'Equals', value: 'eq' },
									{ name: 'Greater Than', value: 'gt' },
									{ name: 'Greater Than or Equal', value: 'ge' },
									{ name: 'In List', value: 'in' },
									{ name: 'Is Not Null', value: 'isNotNull' },
									{ name: 'Is Null', value: 'isNull' },
									{ name: 'Less Than', value: 'lt' },
									{ name: 'Less Than or Equal', value: 'le' },
									{ name: 'Like', value: 'like' },
									{ name: 'Not Equals', value: 'ne' },
									{ name: 'Not In List', value: 'notIn' },
									{ name: 'Not Like', value: 'notLike' },
									{ name: 'Starts With Literal Text', value: 'startsWith' },
								],
								default: 'eq',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								displayOptions: {
									hide: {
										operator: ['isNull', 'isNotNull', 'in', 'notIn', 'between'],
									},
								},
								description: 'Value passed to HANA as a prepared-statement parameter',
							},
							{
								displayName: 'Value Type',
								name: 'valueType',
								type: 'options',
								options: [
									{ name: 'Boolean', value: 'boolean' },
									{ name: 'Number', value: 'number' },
									{ name: 'Null', value: 'null' },
									{ name: 'String / Date / Timestamp', value: 'string' },
								],
								default: 'string',
								displayOptions: {
									hide: { operator: ['isNull', 'isNotNull'] },
								},
								description:
									'How the value is bound to the prepared statement; dates and timestamps use HANA-compatible strings',
							},
							{
								displayName: 'Values JSON',
								name: 'valuesJson',
								type: 'string',
								default: '[]',
								placeholder: '["1010", "1020"]',
								displayOptions: {
									show: { operator: ['in', 'notIn', 'between'] },
								},
								description:
									'JSON array of bound values. BETWEEN needs exactly two; IN and NOT IN allow at most 100.',
							},
						],
					},
				],
			},
			{
				displayName: 'Pagination Mode',
				name: 'paginationMode',
				type: 'options',
				options: [
					{ name: 'Continue After Cursor (Keyset)', value: 'keysetContinue' },
					{ name: 'First Keyset Page', value: 'keysetFirst' },
					{ name: 'No Pagination', value: 'none' },
				],
				default: 'none',
				description:
					'Start with First Keyset Page, then reuse nextCursor with Continue After Cursor. The cursor column must be unique and monotonic.',
				displayOptions: { show: { resource: ['rows'], operation: ['select'] } },
			},
			{
				displayName: 'Cursor Column',
				name: 'cursorColumn',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'CHANGED_AT',
				description:
					'Unique, sortable column used to continue after the previous page; include it in Columns',
				displayOptions: {
					show: {
						resource: ['rows'],
						operation: ['select'],
						paginationMode: ['keysetFirst', 'keysetContinue'],
					},
				},
			},
			{
				displayName: 'Cursor Direction',
				name: 'cursorDirection',
				type: 'options',
				options: [
					{ name: 'Ascending (Values Greater Than Cursor)', value: 'ASC' },
					{ name: 'Descending (Values Less Than Cursor)', value: 'DESC' },
				],
				default: 'ASC',
				displayOptions: {
					show: {
						resource: ['rows'],
						operation: ['select'],
						paginationMode: ['keysetFirst', 'keysetContinue'],
					},
				},
			},
			{
				displayName: 'Cursor Value Type',
				name: 'cursorValueType',
				type: 'options',
				options: [
					{ name: 'Boolean', value: 'boolean' },
					{ name: 'Number', value: 'number' },
					{ name: 'String / Date / Timestamp', value: 'string' },
				],
				default: 'string',
				displayOptions: {
					show: {
						resource: ['rows'],
						operation: ['select'],
						paginationMode: ['keysetContinue'],
					},
				},
			},
			{
				displayName: 'Cursor Value',
				name: 'cursorValue',
				type: 'string',
				default: '',
				required: true,
				description: 'The nextCursor value returned by the previous execution',
				displayOptions: {
					show: {
						resource: ['rows'],
						operation: ['select'],
						paginationMode: ['keysetContinue'],
					},
				},
			},
			{
				displayName: 'Order By',
				name: 'orderBy',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Sort Column',
				displayOptions: { show: { resource: ['rows'], operation: ['select'] } },
				options: [
					{
						displayName: 'Values',
						name: 'values',
						values: [
							{
								displayName: 'Column',
								name: 'column',
								type: 'string',
								default: '',
								required: true,
							},
							{
								displayName: 'Direction',
								name: 'direction',
								type: 'options',
								options: [
									{ name: 'Ascending', value: 'ASC' },
									{ name: 'Descending', value: 'DESC' },
								],
								default: 'ASC',
							},
						],
					},
				],
			},
			{
				displayName: 'Aggregate Function',
				name: 'aggregateFunction',
				type: 'options',
				options: [
					{ name: 'Average', value: 'AVG' },
					{ name: 'Count', value: 'COUNT' },
					{ name: 'Count Distinct', value: 'COUNT_DISTINCT' },
					{ name: 'Maximum', value: 'MAX' },
					{ name: 'Minimum', value: 'MIN' },
					{ name: 'Sum', value: 'SUM' },
				],
				default: 'COUNT',
				displayOptions: { show: { resource: ['rows'], operation: ['aggregate'] } },
			},
			{
				displayName: 'Aggregate Column',
				name: 'aggregateColumn',
				type: 'string',
				default: '',
				required: true,
				description: 'Numeric or comparable column to aggregate',
				displayOptions: {
					show: {
						resource: ['rows'],
						operation: ['aggregate'],
						aggregateFunction: ['AVG', 'COUNT_DISTINCT', 'MAX', 'MIN', 'SUM'],
					},
				},
			},
			{
				displayName: 'Result Alias',
				name: 'aggregateAlias',
				type: 'string',
				default: 'RESULT',
				required: true,
				displayOptions: { show: { resource: ['rows'], operation: ['aggregate'] } },
			},
			{
				displayName: 'Group By',
				name: 'groupBy',
				type: 'string',
				default: '',
				placeholder: 'COMPANY_CODE,CURRENCY',
				description: 'Optional comma-separated grouping columns',
				displayOptions: { show: { resource: ['rows'], operation: ['aggregate'] } },
			},
			{
				displayName: 'SQL',
				name: 'sql',
				type: 'string',
				typeOptions: { rows: 8 },
				default: 'SELECT * FROM "SCHEMA"."VIEW" WHERE "COMPANY_CODE" = ?',
				required: true,
				description: 'One SELECT statement. Expressions are intentionally disabled for this field.',
				noDataExpression: true,
				displayOptions: { show: { resource: ['sql'] } },
			},
			{
				displayName: 'Parameters JSON',
				name: 'parametersJson',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '[]',
				description: 'JSON array bound to the ? placeholders in order',
				displayOptions: { show: { resource: ['sql'] } },
			},
			{
				displayName: 'Row Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: MAX_ROW_LIMIT },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['rows', 'sql'] } },
			},
			{
				displayName: 'Include Result Metadata',
				name: 'includeMetadata',
				type: 'boolean',
				default: true,
				description: 'Whether to add row count, limit, and truncation information',
				hint: 'Keyset pagination always includes metadata so the next cursor is available.',
				displayOptions: { show: { resource: ['rows', 'sql'] } },
			},
		],
	};

	methods = {
		credentialTest: {
			async hanaConnectionTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
			): Promise<INodeCredentialTestResult> {
				try {
					const credentials = credential.data as unknown as HanaCredentials;
					validateGovernanceConfiguration(credentials);
					if (credentials.allowAiTool === true) {
						resolveAiToolPolicy(
							'n8n-nodes-hana-secure.hanaSecureTool',
							1.1,
							'rows',
							'select',
							credentials,
						);
					}
					await withHanaClient(credentials, async (session) => {
						await session.query('SELECT 1 AS "OK" FROM DUMMY');
					});
					return { status: 'OK', message: 'Connection successful' };
				} catch (error) {
					return {
						status: 'Error',
						message: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const inputItems = this.getInputData();
		const outputItems: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex += 1) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const credentials = (await this.getCredentials(
					'hanaSecureApi',
					itemIndex,
				)) as unknown as HanaCredentials;
				validateGovernanceConfiguration(credentials);
				const aiToolPolicy = resolveAiToolPolicy(
					this.getNode().type,
					this.getNode().typeVersion,
					resource,
					operation,
					credentials,
				);

				const result = await withHanaClient(credentials, async (session) => {
					if (resource === 'connection') {
						const rows = await session.query(
							'SELECT CURRENT_USER AS "USER_NAME", CURRENT_SCHEMA AS "SCHEMA_NAME", (SELECT TOP 1 DATABASE_NAME FROM SYS.M_DATABASE) AS "DATABASE_NAME" FROM DUMMY',
						);
						return rows.map((row) => ({
							...row,
							CONNECTED: true,
							TLS_ENABLED: credentials.useTLS,
						}));
					}
					if (resource === 'catalog') {
						return await executeCatalogOperation(
							this,
							session,
							itemIndex,
							operation,
							credentials,
							aiToolPolicy.maxRows,
						);
					}
					if (resource === 'rows') {
						return await executeRowsOperation(
							this,
							session,
							itemIndex,
							operation,
							credentials,
							aiToolPolicy.maxRows,
						);
					}
					return await executeAdvancedSql(this, session, itemIndex, credentials);
				});

				const jsonResult = rowsToJson(result);
				enforceAiToolByteLimit(jsonResult, aiToolPolicy.maxBytes);
				outputItems.push(
					...jsonResult.map((json) => ({
						json: json as IDataObject,
						pairedItem: { item: itemIndex },
					})),
				);
			} catch (error) {
				if (this.continueOnFail()) {
					outputItems.push({
						json: {
							error: error instanceof Error ? error.message : String(error),
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw new NodeOperationError(
					this.getNode(),
					error instanceof Error ? error : new Error(String(error)),
					{ itemIndex },
				);
			}
		}

		return [outputItems];
	}
}
