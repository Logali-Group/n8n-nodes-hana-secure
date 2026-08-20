import {
	NodeConnectionTypes,
	NodeOperationError,
	OperationalError,
	type ICredentialDataDecryptedObject,
	type ICredentialTestFunctions,
	type ICredentialsDecrypted,
	type IExecuteFunctions,
	type ILoadOptionsFunctions,
	type INodeCredentialTestResult,
	type INodeExecutionData,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import {
	loadColumnOptions,
	loadObjectOptions,
	loadSchemaOptions,
	loadTableFunctionColumnOptions,
	loadTableFunctionOptions,
	loadTableFunctionParameterOptions,
} from './catalogOptions';
import { hanaErrorOutput } from './errors';
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
import { enforceJsonByteLimit, rowsToJson } from './json';
import { formatHanaOutput, type HanaOutputMode } from './output';
import {
	assertCursorColumns,
	buildCompositeKeysetWhere,
	collectKeysetPages,
	cursorOrderBy,
	decodeCursor,
	readCursorValue,
	type KeysetCursor,
} from './pagination';
import {
	buildSemanticSource,
	type SemanticParameterInput,
	type SemanticParameterMode,
} from './semanticViews';
import {
	buildTableFunctionSource,
	type TableFunctionInput,
	type TableFunctionParameterMetadata,
} from './tableFunctions';
import {
	assertIdentifier,
	assertSchemaAllowed,
	buildOrderByClause,
	buildWhereClause,
	combineWhereClauses,
	normalizeUiFilters,
	normalizeUiKeyFields,
	parseAllowedSchemas,
	parseIdentifierList,
	parseParametersJson,
	parseTypedValue,
	quoteIdentifier,
	validateAdvancedSelect,
} from './sqlSafety';
import type {
	FilterLogic,
	FilterValueType,
	HanaCredentials,
	OrderBy,
	UiFilter,
	UiKeyField,
} from './types';
import { enforceAiToolByteLimit, resolveAiToolPolicy } from './toolPolicy';

const MAX_ROW_LIMIT = 1000;

async function readTableFunction(
	session: HanaSession,
	schema: string,
	functionName: string,
): Promise<{
	definition: Record<string, unknown>;
	inputs: TableFunctionParameterMetadata[];
	outputColumns: Record<string, unknown>[];
}> {
	const functions = await session.query(
		`SELECT "SCHEMA_NAME", "FUNCTION_NAME", "SQL_SECURITY", "INPUT_PARAMETER_COUNT", "RETURN_VALUE_COUNT", "IS_DETERMINISTIC", "OWNER_NAME", "CREATE_TIME"
FROM "SYS"."FUNCTIONS"
WHERE "SCHEMA_NAME" = ? AND "FUNCTION_NAME" = ? AND "FUNCTION_USAGE_TYPE" = 'TABLE' AND "IS_VALID" = 'TRUE'`,
		[schema, functionName],
	);
	if (functions.length !== 1) {
		throw new OperationalError('The selected valid HANA table function is not visible.');
	}
	const parameterRows = await session.query(
		`SELECT "PARAMETER_NAME", "DATA_TYPE_NAME", "LENGTH", "SCALE", "POSITION", "PARAMETER_TYPE", "HAS_DEFAULT_VALUE", "IS_NULLABLE"
FROM "SYS"."FUNCTION_PARAMETERS"
WHERE "SCHEMA_NAME" = ? AND "FUNCTION_NAME" = ?
ORDER BY "POSITION"`,
		[schema, functionName],
	);
	const inputs = parameterRows
		.filter((row) => ['IN', 'INOUT'].includes(String(row.PARAMETER_TYPE).toUpperCase()))
		.map((row) => ({
			name: String(row.PARAMETER_NAME),
			dataTypeName: String(row.DATA_TYPE_NAME),
			position: Number(row.POSITION),
			parameterType: String(row.PARAMETER_TYPE),
		}));
	const outputColumns = await session.query(
		`SELECT "PARAMETER_NAME", "PARAMETER_POSITION", "COLUMN_NAME", "POSITION", "DATA_TYPE_NAME", "LENGTH", "SCALE", "IS_NULLABLE"
FROM "SYS"."FUNCTION_PARAMETER_COLUMNS"
WHERE "SCHEMA_NAME" = ? AND "FUNCTION_NAME" = ?
ORDER BY "PARAMETER_POSITION", "POSITION"`,
		[schema, functionName],
	);
	return { definition: functions[0], inputs, outputColumns };
}

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

export async function executeCatalogOperation(
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
			`SELECT "SCHEMA_NAME", "TABLE_NAME" AS "OBJECT_NAME", CASE WHEN "TABLE_TYPE" = 'VIRTUAL' THEN 'VIRTUAL_TABLE' ELSE 'TABLE' END AS "OBJECT_TYPE", NULL AS "VIEW_TYPE", CASE WHEN "TABLE_TYPE" = 'VIRTUAL' THEN 'UNKNOWN' ELSE 'FALSE' END AS "HAS_PARAMETERS"
FROM "SYS"."TABLES" WHERE "SCHEMA_NAME" = ? AND "TABLE_NAME" LIKE ? ESCAPE '\\'${objectPredicate}
UNION ALL
SELECT "SCHEMA_NAME", "VIEW_NAME" AS "OBJECT_NAME", 'VIEW' AS "OBJECT_TYPE", "VIEW_TYPE", "HAS_PARAMETERS"
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
	if (operation === 'listTableFunctions') {
		const prefix = context.getNodeParameter('objectNamePrefix', itemIndex, '') as string;
		const limit = rowLimit(
			context.getNodeParameter('catalogLimit', itemIndex, 100) as number,
			aiToolMaxRows,
		);
		const escapedPrefix = prefix.replace(/[\\%_]/g, '\\$&');
		const governedNames = allowedObjectNamesForSchema(schema, allowedObjects);
		if (aiToolMaxRows !== undefined && allowedObjects.size === 0) {
			return addResultMetadata([], operation, limit, true, {
				objectAllowlistApplied: false,
				functionAllowlistRequiredForAi: true,
			});
		}
		if (governedNames?.length === 0) {
			return addResultMetadata([], operation, limit, true, { objectAllowlistApplied: true });
		}
		const namePredicate = governedNames
			? ` AND "FUNCTION_NAME" IN (${governedNames.map(() => '?').join(', ')})`
			: '';
		const rows = await session.query(
			`SELECT "SCHEMA_NAME", "FUNCTION_NAME", "SQL_SECURITY", "INPUT_PARAMETER_COUNT", "RETURN_VALUE_COUNT", "IS_DETERMINISTIC", "OWNER_NAME", "CREATE_TIME"
FROM "SYS"."FUNCTIONS"
WHERE "SCHEMA_NAME" = ? AND "FUNCTION_NAME" LIKE ? ESCAPE '\\' AND "FUNCTION_USAGE_TYPE" = 'TABLE' AND "IS_VALID" = 'TRUE'${namePredicate}
ORDER BY "FUNCTION_NAME"
LIMIT ${limit + 1}`,
			governedNames
				? [schema, `${escapedPrefix}%`, ...governedNames]
				: [schema, `${escapedPrefix}%`],
		);
		const governedRows = rows.filter((row) =>
			isObjectAllowed(schema, String(row.FUNCTION_NAME), allowedObjects),
		);
		return addResultMetadata(governedRows, operation, limit, true, {
			objectAllowlistApplied: allowedObjects.size > 0,
			functionUsageType: 'TABLE',
		});
	}
	if (operation === 'describeTableFunction') {
		if (aiToolMaxRows !== undefined && allowedObjects.size === 0) {
			throw new OperationalError(
				'AI Tool calls may describe table functions only when Allowed Objects explicitly lists them.',
			);
		}
		const functionName = assertIdentifier(
			context.getNodeParameter('functionName', itemIndex) as string,
			'function name',
		);
		assertObjectAllowed(schema, functionName, allowedObjects);
		const functionMetadata = await readTableFunction(session, schema, functionName);
		const allowedColumns = allowedColumnsForObject(schema, functionName, columnPolicies);
		const visibleOutputColumns = allowedColumns
			? functionMetadata.outputColumns.filter((row) =>
					allowedColumns.some(
						(column) => column.toUpperCase() === String(row.COLUMN_NAME).toUpperCase(),
					),
				)
			: functionMetadata.outputColumns;
		return [
			{
				...functionMetadata.definition,
				INPUT_PARAMETERS: functionMetadata.inputs,
				OUTPUT_COLUMNS: visibleOutputColumns,
				COLUMN_POLICY_APPLIED: allowedColumns !== undefined,
				INVOCATION_PATTERN: `SELECT * FROM ${schema}.${functionName}(...)`,
			},
		];
	}

	const objectType = context.getNodeParameter('objectType', itemIndex, 'auto') as
		| 'auto'
		| 'table'
		| 'view';
	const objectName = assertIdentifier(
		context.getNodeParameter('objectName', itemIndex) as string,
		'object name',
	);
	assertObjectAllowed(schema, objectName, allowedObjects);
	if (operation === 'listConstraints') {
		const rows = await session.query(
			`SELECT "CONSTRAINT_NAME", "COLUMN_NAME", "POSITION", "IS_PRIMARY_KEY", "IS_UNIQUE_KEY"
FROM "SYS"."CONSTRAINTS"
WHERE "SCHEMA_NAME" = ? AND "TABLE_NAME" = ?
ORDER BY "CONSTRAINT_NAME", "POSITION"`,
			[schema, objectName],
		);
		const allowedColumns = allowedColumnsForObject(schema, objectName, columnPolicies);
		const governedRows = allowedColumns
			? rows.filter((row) =>
					allowedColumns.some(
						(column) => column.toUpperCase() === String(row.COLUMN_NAME).toUpperCase(),
					),
				)
			: rows;
		return addResultMetadata(governedRows, operation, 100, true, {
			primaryKeyColumns: governedRows
				.filter((row) => String(row.IS_PRIMARY_KEY).toUpperCase() === 'TRUE')
				.map((row) => row.COLUMN_NAME),
		});
	}
	if (operation === 'inspectSemanticView') {
		const rows = await session.query(
			`SELECT "SCHEMA_NAME", "VIEW_NAME", "VIEW_TYPE", "IS_COLUMN_VIEW", "IS_READ_ONLY", "IS_VALID", "HAS_PARAMETERS", "COMMENTS"
FROM "SYS"."VIEWS"
WHERE "SCHEMA_NAME" = ? AND "VIEW_NAME" = ?`,
			[schema, objectName],
		);
		if (rows.length === 0) {
			const virtualRows = await session.query(
				`SELECT "SCHEMA_NAME", "TABLE_NAME", "REMOTE_SOURCE_NAME", "REMOTE_DB_NAME", "REMOTE_OWNER_NAME", "REMOTE_OBJECT_NAME", "IS_SELECTABLE"
FROM "SYS"."VIRTUAL_TABLES"
WHERE "SCHEMA_NAME" = ? AND "TABLE_NAME" = ?`,
				[schema, objectName],
			);
			if (virtualRows.length === 0) {
				const functionRows = await session.query(
					`SELECT "SCHEMA_NAME", "FUNCTION_NAME", "SQL_SECURITY", "INPUT_PARAMETER_COUNT", "RETURN_VALUE_COUNT", "IS_DETERMINISTIC", "OWNER_NAME", "CREATE_TIME"
FROM "SYS"."FUNCTIONS"
WHERE "SCHEMA_NAME" = ? AND "FUNCTION_NAME" = ? AND "FUNCTION_USAGE_TYPE" = 'TABLE' AND "IS_VALID" = 'TRUE'`,
					[schema, objectName],
				);
				if (functionRows.length === 0) {
					throw new OperationalError(
						'The selected object is not a visible HANA runtime view, virtual table, or table function.',
					);
				}
				return functionRows.map((row) => ({
					...row,
					SEMANTIC_KIND: 'HANA_TABLE_FUNCTION_OR_PARAMETERIZED_ABAP_CDS',
					DIRECT_SQL_QUERYABLE: true,
					REQUIRES_PARAMETERS: Number(row.INPUT_PARAMETER_COUNT ?? 0) > 0,
					INVOCATION_MODE: 'TABLE_FUNCTION_POSITIONAL',
					CDS_NOTE:
						'Parameterized ABAP CDS runtime objects are commonly exposed in HANA as table functions. Use Describe Table Function and Row Source → Table Function / Parameterized ABAP CDS to inspect and invoke this object safely.',
				}));
			}
			return virtualRows.map((row) => ({
				...row,
				SEMANTIC_KIND: 'VIRTUAL_RUNTIME_VIEW',
				DIRECT_SQL_QUERYABLE: String(row.IS_SELECTABLE).toUpperCase() === 'TRUE',
				REQUIRES_PARAMETERS: 'UNKNOWN',
				CDS_NOTE:
					'This virtual table can expose a remote runtime object, including an ABAP CDS-backed object when configured through supported HANA data access. Use List Semantic View Parameters to inspect its positional parameters.',
			}));
		}
		return rows.map((row) => ({
			...row,
			SEMANTIC_KIND:
				String(row.VIEW_TYPE).toUpperCase() === 'CALC'
					? 'HANA_CALCULATION_VIEW'
					: String(row.HAS_PARAMETERS).toUpperCase() === 'TRUE'
						? 'PARAMETERIZED_HANA_VIEW'
						: 'SQL_RUNTIME_VIEW',
			DIRECT_SQL_QUERYABLE: String(row.IS_VALID).toUpperCase() === 'TRUE',
			REQUIRES_PARAMETERS: String(row.HAS_PARAMETERS).toUpperCase() === 'TRUE',
			CDS_NOTE:
				'HANA exposes the runtime SQL view, not the ABAP CDS source. ABAP CDS view entities without a SQL view require a released API, OData, or ABAP access.',
		}));
	}
	if (operation === 'listSemanticParameters') {
		const viewRows = await session.query(
			`SELECT "VIEW_TYPE", "HAS_PARAMETERS"
FROM "SYS"."VIEWS"
WHERE "SCHEMA_NAME" = ? AND "VIEW_NAME" = ?`,
			[schema, objectName],
		);
		if (viewRows.length === 0) {
			const virtualObjectRows = await session.query(
				`SELECT "TABLE_NAME"
FROM "SYS"."VIRTUAL_TABLES"
WHERE "SCHEMA_NAME" = ? AND "TABLE_NAME" = ?`,
				[schema, objectName],
			);
			if (virtualObjectRows.length > 0) {
				const virtualRows = await session.query(
				`SELECT "PARAMETER_NAME", "DATA_TYPE_NAME", "LENGTH", "SCALE", "POSITION", "HAS_DEFAULT_VALUE", "IS_MANDATORY", "DEFAULT_VALUE"
FROM "SYS"."VIRTUAL_TABLE_PARAMETERS"
WHERE "SCHEMA_NAME" = ? AND "OBJECT_NAME" = ?
ORDER BY "POSITION"`,
					[schema, objectName],
				);
				return addResultMetadata(
					virtualRows.map((row) => ({
						...row,
						BINDING_MODE: 'SQL_POSITIONAL',
						INPUT_NAME: row.PARAMETER_NAME,
					})),
					operation,
					20,
					true,
					{ semanticKind: 'VIRTUAL_RUNTIME_VIEW', hasParameters: virtualRows.length > 0 },
				);
			}

			const functionMetadata = await readTableFunction(session, schema, objectName);
			return addResultMetadata(
				functionMetadata.inputs.map((row) => ({
					PARAMETER_NAME: row.name,
					DATA_TYPE_NAME: row.dataTypeName,
					POSITION: row.position,
					PARAMETER_TYPE: row.parameterType,
					BINDING_MODE: 'TABLE_FUNCTION_POSITIONAL',
					INPUT_NAME: row.name,
				})),
				operation,
				20,
				true,
				{
					semanticKind: 'HANA_TABLE_FUNCTION_OR_PARAMETERIZED_ABAP_CDS',
					hasParameters: functionMetadata.inputs.length > 0,
				},
			);
		}
		const isCalculationView = String(viewRows[0].VIEW_TYPE).toUpperCase() === 'CALC';
		const rows = isCalculationView
			? await session.query(
					`SELECT "PARAMETER_NAME", "IS_MANDATORY", "DEFAULT_VALUE"
FROM "SYS"."CS_VIEW_PARAMETERS"
WHERE "SCHEMA_NAME" = ? AND "OBJECT_NAME" = ?
ORDER BY "PARAMETER_NAME"`,
					[schema, objectName],
				)
			: await session.query(
					`SELECT "PARAMETER_NAME", "DATA_TYPE_NAME", "LENGTH", "SCALE", "POSITION", "HAS_DEFAULT_VALUE"
FROM "SYS"."VIEW_PARAMETERS"
WHERE "SCHEMA_NAME" = ? AND "VIEW_NAME" = ?
ORDER BY "POSITION"`,
					[schema, objectName],
				);
		return addResultMetadata(
			rows.map((row) => ({
				...row,
				BINDING_MODE: isCalculationView ? 'CALCULATION_PLACEHOLDER' : 'SQL_POSITIONAL',
				INPUT_NAME: isCalculationView
					? String(row.PARAMETER_NAME).replace(/^\$\$(.*)\$\$$/, '$1')
					: row.PARAMETER_NAME,
			})),
			operation,
			20,
			true,
			{
				semanticKind: isCalculationView ? 'HANA_CALCULATION_VIEW' : 'PARAMETERIZED_HANA_VIEW',
				hasParameters: String(viewRows[0].HAS_PARAMETERS).toUpperCase() === 'TRUE',
			},
		);
	}
	let resolvedObjectType: 'auto' | 'table' | 'view' | 'virtual_table' = objectType;
	if (objectType === 'auto') {
		const typeRows = await session.query(
			`SELECT CASE WHEN "TABLE_TYPE" = 'VIRTUAL' THEN 'VIRTUAL_TABLE' ELSE 'TABLE' END AS "OBJECT_TYPE" FROM "SYS"."TABLES" WHERE "SCHEMA_NAME" = ? AND "TABLE_NAME" = ?
UNION ALL
SELECT 'VIEW' AS "OBJECT_TYPE" FROM "SYS"."VIEWS" WHERE "SCHEMA_NAME" = ? AND "VIEW_NAME" = ?
LIMIT 1`,
			[schema, objectName, schema, objectName],
		);
		if (typeRows.length === 0)
			throw new OperationalError('The table or view is not visible in HANA.');
		resolvedObjectType = String(typeRows[0].OBJECT_TYPE).toLowerCase() as
			| 'table'
			| 'view'
			| 'virtual_table';
	}
	const catalogView =
		resolvedObjectType === 'view'
			? 'VIEW_COLUMNS'
			: resolvedObjectType === 'virtual_table'
				? 'VIRTUAL_COLUMNS'
				: 'TABLE_COLUMNS';
	const objectColumn = resolvedObjectType === 'view' ? 'VIEW_NAME' : 'TABLE_NAME';
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
	const sourceKind =
		context.getNode().typeVersion >= 1.4
			? (context.getNodeParameter('sourceKind', itemIndex, 'tableOrView') as
					| 'tableOrView'
					| 'tableFunction')
			: 'tableOrView';
	const objectName = assertIdentifier(
		context.getNodeParameter(
			sourceKind === 'tableFunction' ? 'functionName' : 'objectName',
			itemIndex,
		) as string,
		sourceKind === 'tableFunction' ? 'function name' : 'object name',
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
	const requestedSemanticParameterMode =
		context.getNode().typeVersion >= 1.3 && sourceKind === 'tableOrView'
			? (context.getNodeParameter('semanticParameterMode', itemIndex, 'auto') as
					| SemanticParameterMode
					| 'auto')
			: 'none';
	const semanticParameters = valuesFromCollection<SemanticParameterInput>(
		context.getNodeParameter('semanticParameters', itemIndex, {}),
	);
	let semanticParameterMode: SemanticParameterMode =
		requestedSemanticParameterMode === 'auto' ? 'none' : requestedSemanticParameterMode;
	if (sourceKind === 'tableOrView' && requestedSemanticParameterMode === 'auto') {
		const viewRows = await session.query(
			`SELECT "VIEW_TYPE", "HAS_PARAMETERS" FROM "SYS"."VIEWS" WHERE "SCHEMA_NAME" = ? AND "VIEW_NAME" = ?`,
			[schema, objectName],
		);
		if (viewRows.length > 0 && String(viewRows[0].HAS_PARAMETERS).toUpperCase() === 'TRUE') {
			semanticParameterMode =
				String(viewRows[0].VIEW_TYPE).toUpperCase() === 'CALC'
					? 'calculationPlaceholders'
					: 'sqlPositional';
		} else if (viewRows.length === 0) {
			const virtualParameterRows = await session.query(
				`SELECT COUNT(*) AS "PARAMETER_COUNT" FROM "SYS"."VIRTUAL_TABLE_PARAMETERS" WHERE "SCHEMA_NAME" = ? AND "OBJECT_NAME" = ?`,
				[schema, objectName],
			);
			if (Number(virtualParameterRows[0]?.PARAMETER_COUNT ?? 0) > 0) {
				semanticParameterMode = 'sqlPositional';
			}
		}
	}
	let tableReference: string;
	let sourceParameters: unknown[];
	let functionSecurity: unknown;
	if (sourceKind === 'tableFunction') {
		if (aiToolMaxRows !== undefined && allowedObjects.size === 0) {
			throw new OperationalError(
				'AI Tool calls may invoke table functions only when Allowed Objects explicitly lists them.',
			);
		}
		const functionMetadata = await readTableFunction(session, schema, objectName);
		const functionInputs = valuesFromCollection<TableFunctionInput>(
			context.getNodeParameter('tableFunctionParameters', itemIndex, {}),
		);
		const functionSource = buildTableFunctionSource(
			schema,
			objectName,
			functionInputs,
			functionMetadata.inputs,
		);
		tableReference = functionSource.sql;
		sourceParameters = functionSource.parameters;
		functionSecurity = functionMetadata.definition.SQL_SECURITY;
		semanticParameterMode = 'none';
	} else {
		const semanticSource = buildSemanticSource(
			schema,
			objectName,
			semanticParameterMode,
			semanticParameters,
		);
		tableReference = semanticSource.sql;
		sourceParameters = semanticSource.parameters;
	}
	const policyMetadata = {
		source: `${schema}.${objectName}`,
		sourceKind,
		semanticParameterMode,
		...(sourceKind === 'tableFunction'
			? { functionUsageType: 'TABLE', functionSecurity }
			: {}),
		objectAllowlistApplied: allowedObjects.size > 0,
		columnPolicyApplied: allowedColumns !== undefined,
		requiredFilterCount: requiredFilters.length,
	};

	if (operation === 'getByKey') {
		const keyFields = valuesFromCollection<UiKeyField>(
			context.getNodeParameter('keyFields', itemIndex, {}),
		);
		const normalizedKeys = normalizeUiKeyFields(keyFields);
		assertColumnsAllowed(
			normalizedKeys.map((filter) => filter.column),
			allowedColumns,
		);

		const rawColumns = context.getNodeParameter('columns', itemIndex, '*') as string;
		const guidedColumns =
			context.getNode().typeVersion >= 1.3
				? (context.getNodeParameter('selectedColumns', itemIndex, []) as string[])
				: [];
		const selectedColumns =
			context.getNode().typeVersion >= 1.3
				? guidedColumns.length > 0
					? guidedColumns.map((column) => assertIdentifier(column, 'column'))
					: allowedColumns
				: rawColumns.trim() === '*'
					? allowedColumns
					: parseIdentifierList(rawColumns, 'column');
		if (selectedColumns) assertColumnsAllowed(selectedColumns, allowedColumns);
		const columns = selectedColumns
			? selectedColumns.map((column) => quoteIdentifier(column)).join(', ')
			: '*';
		const keyWhere = buildWhereClause(normalizedKeys, 'AND');
		const where = combineWhereClauses(requiredWhere, keyWhere);
		const queryStartedAt = Date.now();
		const rows = await session.query(
			`SELECT ${columns} FROM ${tableReference}${where.sql} LIMIT 2`,
			[...sourceParameters, ...where.parameters],
		);
		const durationMs = Date.now() - queryStartedAt;
		if (rows.length > 1) {
			throw new OperationalError(
				'Get One by Key matched more than one row. Add every column from the unique or business key.',
			);
		}
		const failIfNotFound = context.getNodeParameter('failIfNotFound', itemIndex, true) as boolean;
		if (rows.length === 0 && failIfNotFound) {
			throw new OperationalError('No HANA row matched the complete key.');
		}
		const includeMetadata =
			rows.length === 0 ||
			(context.getNodeParameter('includeMetadata', itemIndex, true) as boolean);
		return addResultMetadata(rows, operation, 1, includeMetadata, {
			...policyMetadata,
			durationMs,
			found: rows.length === 1,
			keyColumns: normalizedKeys.map((filter) => filter.column),
		});
	}

	if (operation === 'exists' || operation === 'count') {
		const where = combineWhereClauses(requiredWhere, userWhere);
		const queryStartedAt = Date.now();
		const rows =
			operation === 'exists'
				? await session.query(
						`SELECT 1 AS "MATCH_FOUND" FROM ${tableReference}${where.sql} LIMIT 1`,
						[...sourceParameters, ...where.parameters],
					)
				: await session.query(`SELECT COUNT(*) AS "ROW_COUNT" FROM ${tableReference}${where.sql}`, [
						...sourceParameters,
						...where.parameters,
					]);
		const result =
			operation === 'exists'
				? [{ EXISTS: rows.length === 1 }]
				: [{ ROW_COUNT: rows[0]?.ROW_COUNT ?? 0 }];
		return addResultMetadata(result, operation, 1, true, {
			...policyMetadata,
			durationMs: Date.now() - queryStartedAt,
		});
	}

	if (operation === 'select' || operation === 'preview' || operation === 'distinct') {
		const guidedColumns =
			context.getNode().typeVersion >= 1.3
				? (context.getNodeParameter('selectedColumns', itemIndex, []) as string[])
				: [];
		const rawColumns = context.getNodeParameter('columns', itemIndex, '*') as string;
		const selectedColumns =
			context.getNode().typeVersion >= 1.3
				? guidedColumns.length > 0
					? guidedColumns.map((column) => assertIdentifier(column, 'column'))
					: allowedColumns
				: rawColumns.trim() === '*'
					? allowedColumns
					: parseIdentifierList(rawColumns, 'column');
		if (selectedColumns) assertColumnsAllowed(selectedColumns, allowedColumns);
		const columns = selectedColumns
			? selectedColumns.map((column) => quoteIdentifier(column)).join(', ')
			: '*';
		if (operation === 'distinct') {
			if (!selectedColumns || selectedColumns.length === 0) {
				throw new OperationalError('Select at least one approved column for Distinct Values.');
			}
			const where = combineWhereClauses(requiredWhere, userWhere);
			const distinctLimit = rowLimit(
				context.getNodeParameter('limit', itemIndex, 50) as number,
				aiToolMaxRows,
			);
			const queryStartedAt = Date.now();
			const rows = await session.query(
				`SELECT DISTINCT ${columns} FROM ${tableReference}${where.sql} ORDER BY ${columns} LIMIT ${distinctLimit + 1}`,
				[...sourceParameters, ...where.parameters],
			);
			return addResultMetadata(rows, operation, distinctLimit, true, {
				...policyMetadata,
				durationMs: Date.now() - queryStartedAt,
			});
		}
		if (operation === 'preview') {
			const previewLimit = 5;
			const where = combineWhereClauses(requiredWhere, userWhere);
			const queryStartedAt = Date.now();
			const rows = await session.query(
				`SELECT ${columns} FROM ${tableReference}${where.sql} LIMIT ${previewLimit}`,
				[...sourceParameters, ...where.parameters],
			);
			return addResultMetadata(rows, operation, previewLimit, true, {
				...policyMetadata,
				durationMs: Date.now() - queryStartedAt,
				preview: true,
			});
		}
		let orderBy = valuesFromCollection<OrderBy>(context.getNodeParameter('orderBy', itemIndex, {}));
		assertColumnsAllowed(
			orderBy.map((sort) => sort.column),
			allowedColumns,
		);

		const paginationMode = context.getNodeParameter('paginationMode', itemIndex, 'none') as string;
		if (context.getNode().typeVersion >= 1.3 && paginationMode !== 'none') {
			const cursorColumns = assertCursorColumns(
				(context.getNodeParameter('cursorColumns', itemIndex, []) as string[]).map((column) =>
					assertIdentifier(column, 'cursor column'),
				),
			);
			assertColumnsAllowed(cursorColumns, allowedColumns);
			if (
				selectedColumns &&
				cursorColumns.some(
					(cursorColumn) =>
						!selectedColumns.some((column) => column.toUpperCase() === cursorColumn.toUpperCase()),
				)
			) {
				throw new OperationalError('Every cursor column must be included in Selected Columns.');
			}
			const cursorDirection = context.getNodeParameter('cursorDirection', itemIndex, 'ASC') as
				| 'ASC'
				| 'DESC';
			orderBy = cursorOrderBy(cursorColumns, cursorDirection, orderBy);
			const baseWhere = combineWhereClauses(requiredWhere, userWhere);
			const pageSize = rowLimit(
				context.getNodeParameter('limit', itemIndex) as number,
				aiToolMaxRows,
			);
			let cursor: KeysetCursor | undefined;
			if (paginationMode === 'keysetContinue') {
				cursor = decodeCursor(context.getNodeParameter('cursorToken', itemIndex) as string);
				if (
					cursor.direction !== cursorDirection ||
					cursor.columns.map((column) => column.toUpperCase()).join('|') !==
						cursorColumns.map((column) => column.toUpperCase()).join('|')
				) {
					throw new OperationalError(
						'The cursor token does not match the configured cursor columns and direction.',
					);
				}
			}

			const automatic = paginationMode === 'automatic';
			const maximumRows = automatic
				? Math.min(
						context.getNodeParameter('automaticMaxRows', itemIndex, 5000) as number,
						aiToolMaxRows ?? 10_000,
					)
				: pageSize;
			const maximumPages = automatic
				? (context.getNodeParameter('automaticMaxPages', itemIndex, 50) as number)
				: 1;
			if (!Number.isInteger(maximumRows) || maximumRows < 1 || maximumRows > 10_000) {
				throw new OperationalError(
					'Automatic pagination maximum rows must be between 1 and 10000.',
				);
			}
			if (!Number.isInteger(maximumPages) || maximumPages < 1 || maximumPages > 100) {
				throw new OperationalError('Automatic pagination maximum pages must be between 1 and 100.');
			}

			const queryStartedAt = Date.now();
			const pageCollection = await collectKeysetPages(
				cursorColumns,
				cursorDirection,
				pageSize,
				maximumRows,
				maximumPages,
				cursor,
				async (pageCursor, currentLimit) => {
					const cursorWhere = pageCursor
						? buildCompositeKeysetWhere(pageCursor)
						: { sql: '', parameters: [] };
					const where = combineWhereClauses(baseWhere, cursorWhere);
					return await session.query(
						`SELECT ${columns} FROM ${tableReference}${where.sql}${buildOrderByClause(orderBy)} LIMIT ${currentLimit + 1}`,
						[...sourceParameters, ...where.parameters],
					);
				},
			);
			return addResultMetadata(pageCollection.rows, operation, maximumRows, true, {
				...policyMetadata,
				durationMs: Date.now() - queryStartedAt,
				paginationMode,
				pagesFetched: pageCollection.pagesFetched,
				hasMore: pageCollection.hasMore,
				truncated: pageCollection.hasMore,
				...(pageCollection.nextCursor === undefined
					? {}
					: { nextCursor: pageCollection.nextCursor, cursorColumns, cursorDirection }),
			});
		}
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
		const rows = await session.query(sql, [...sourceParameters, ...where.parameters]);
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

	const aggregateDefinitions =
		context.getNode().typeVersion >= 1.3
			? valuesFromCollection<{ function: string; column?: string; alias: string }>(
					context.getNodeParameter('aggregates', itemIndex, {}),
				)
			: [
					{
						function: context.getNodeParameter('aggregateFunction', itemIndex) as string,
						column: context.getNodeParameter('aggregateColumn', itemIndex, '') as string,
						alias: context.getNodeParameter('aggregateAlias', itemIndex) as string,
					},
				];
	if (aggregateDefinitions.length === 0) {
		throw new OperationalError('Add at least one aggregate calculation.');
	}
	if (aggregateDefinitions.length > 10) {
		throw new OperationalError('A query supports at most 10 aggregate calculations.');
	}
	const aliases = aggregateDefinitions.map((aggregate) =>
		assertIdentifier(aggregate.alias, 'aggregate alias'),
	);
	if (new Set(aliases.map((alias) => alias.toUpperCase())).size !== aliases.length) {
		throw new OperationalError('Aggregate aliases must be unique.');
	}
	const aggregateColumns = aggregateDefinitions
		.filter((aggregate) => aggregate.function !== 'COUNT')
		.map((aggregate) => assertIdentifier(aggregate.column ?? '', 'aggregate column'));
	const aggregateExpressions = aggregateDefinitions.map((aggregate, index) => {
		if (!['AVG', 'COUNT', 'COUNT_DISTINCT', 'MAX', 'MIN', 'SUM'].includes(aggregate.function)) {
			throw new OperationalError(`Unsupported aggregate function "${aggregate.function}".`);
		}
		const expression =
			aggregate.function === 'COUNT'
				? 'COUNT(*)'
				: aggregate.function === 'COUNT_DISTINCT'
					? `COUNT(DISTINCT ${quoteIdentifier(aggregate.column ?? '', 'aggregate column')})`
					: `${aggregate.function}(${quoteIdentifier(aggregate.column ?? '', 'aggregate column')})`;
		return `${expression} AS ${quoteIdentifier(aliases[index], 'aggregate alias')}`;
	});
	const groupByRaw = context.getNodeParameter('groupBy', itemIndex, '') as string;
	const groupByColumns =
		context.getNode().typeVersion >= 1.3
			? (context.getNodeParameter('groupByColumns', itemIndex, []) as string[]).map((column) =>
					assertIdentifier(column, 'group column'),
				)
			: groupByRaw.trim()
				? parseIdentifierList(groupByRaw, 'group column')
				: [];
	assertColumnsAllowed([...aggregateColumns, ...groupByColumns], allowedColumns);
	const where = combineWhereClauses(requiredWhere, userWhere);
	const groupSelect = groupByColumns.map((column) => quoteIdentifier(column)).join(', ');
	const groupClause = groupSelect ? ` GROUP BY ${groupSelect}` : '';
	const selectClause = groupSelect
		? `${groupSelect}, ${aggregateExpressions.join(', ')}`
		: aggregateExpressions.join(', ');
	const sql = `SELECT ${selectClause} FROM ${tableReference}${where.sql}${groupClause} LIMIT ${limit + 1}`;
	const queryStartedAt = Date.now();
	const rows = await session.query(sql, [...sourceParameters, ...where.parameters]);
	const durationMs = Date.now() - queryStartedAt;
	const includeMetadata = context.getNodeParameter('includeMetadata', itemIndex, true) as boolean;
	return addResultMetadata(rows, operation, limit, includeMetadata, {
		...policyMetadata,
		durationMs,
		aggregateCount: aggregateDefinitions.length,
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
		version: [1, 1.1, 1.2, 1.3, 1.4],
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
					{ name: 'Catalog', value: 'catalog' },
					{ name: 'Connection', value: 'connection' },
					{ name: 'Governance', value: 'governance' },
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
					{
						name: 'Get Database Information',
						value: 'getDatabaseInfo',
						action: 'Get database information',
						description:
							'Return the visible HANA system ID, database, version, usage, and start time',
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
						name: 'Describe Table Function / Parameterized CDS',
						value: 'describeTableFunction',
						action: 'Describe a table function or parameterized CDS runtime',
						description:
							'Return inputs, output columns, and security metadata for a table function, including a parameterized ABAP CDS runtime',
					},
					{
						name: 'Describe Table or View',
						value: 'describeObject',
						action: 'Describe a table or view',
						description: 'Return column metadata from the HANA system catalog',
					},
					{
						name: 'Inspect Semantic/CDS Runtime View',
						value: 'inspectSemanticView',
						action: 'Inspect a semantic runtime view',
						description:
							'Recognize a visible HANA runtime SQL view, virtual table, calculation view, or parameterized CDS table function without claiming access to ABAP CDS source',
					},
					{
						name: 'List Keys and Constraints',
						value: 'listConstraints',
						action: 'List keys and constraints',
						description: 'Discover governed primary-key and unique-key columns for a table',
					},
					{
						name: 'List Schemas',
						value: 'listSchemas',
						action: 'List schemas',
						description: 'List visible schemas, restricted by the credential allowlist',
					},
					{
						name: 'List Semantic View Parameters',
						value: 'listSemanticParameters',
						action: 'List semantic view parameters',
						description:
							'Discover positional SQL-view parameters or named calculation-view placeholders',
					},
					{
						name: 'List Table Functions / Parameterized CDS',
						value: 'listTableFunctions',
						action: 'List table functions',
						description:
							'List visible, valid HANA table functions, including parameterized ABAP CDS runtimes, in one allowed schema',
					},
					{
						name: 'List Tables and Views',
						value: 'listObjects',
						action: 'List tables and views',
						description: 'List tables, views, and virtual tables in one allowed schema',
					},
				],
				default: 'listSchemas',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['governance'] } },
				options: [
					{
						name: 'Inspect Active Policy',
						value: 'inspectPolicy',
						action: 'Inspect the active policy',
						description:
							'Return a sanitized summary of the credential guardrails without exposing filter values or secrets',
					},
				],
				default: 'inspectPolicy',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['rows'] } },
				options: [
					{
						name: 'Aggregate Rows',
						value: 'aggregate',
						action: 'Aggregate rows',
						description: 'Calculate a grouped or ungrouped aggregate',
					},
					{
						name: 'Count Rows',
						value: 'count',
						action: 'Count rows',
						description: 'Count governed rows matching the configured filters',
					},
					{
						name: 'Distinct Values',
						value: 'distinct',
						action: 'Get distinct values',
						description: 'Return unique combinations of selected approved columns',
					},
					{
						name: 'Exists',
						value: 'exists',
						action: 'Check whether a row exists',
						description: 'Return true or false without reading a complete result set',
					},
					{
						name: 'Get One by Key',
						value: 'getByKey',
						action: 'Get one row by key',
						description:
							'Read exactly one row using one or more equality key fields; duplicate matches fail closed',
					},
					{
						name: 'Preview Rows',
						value: 'preview',
						action: 'Preview rows',
						description: 'Return at most five governed rows for safe inspection',
					},
					{
						name: 'Select Rows',
						value: 'select',
						action: 'Select rows',
						description: 'Read rows with validated identifiers and bound filter values',
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
				displayName: 'Schema Name or ID',
				name: 'schema',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getSchemas' },
				default: '',
				required: true,
				description:
					'Schema containing the table or view. Options are filtered by the credential governance policy. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						resource: ['catalog'],
						operation: [
							'describeTableFunction',
							'listObjects',
							'listTableFunctions',
							'describeObject',
							'inspectSemanticView',
							'listSemanticParameters',
							'listConstraints',
						],
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
					show: { resource: ['catalog'], operation: ['listObjects', 'listTableFunctions'] },
				},
			},
			{
				displayName: 'Catalog Result Limit',
				name: 'catalogLimit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: MAX_ROW_LIMIT },
				default: 100,
				description: 'Maximum number of objects returned by catalog discovery',
				displayOptions: {
					show: { resource: ['catalog'], operation: ['listObjects', 'listTableFunctions'] },
				},
			},
			{
				displayName: 'Schema Name or ID',
				name: 'schema',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getSchemas' },
				default: '',
				required: true,
				description:
					'Schema containing the table or view. Options are filtered by the credential governance policy. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: { show: { resource: ['rows'] } },
			},
			{
				displayName: 'Row Source',
				name: 'sourceKind',
				type: 'options',
				options: [
					{ name: 'Table or View', value: 'tableOrView' },
					{
						name: 'Table Function / Parameterized ABAP CDS',
						value: 'tableFunction',
					},
				],
				default: 'tableOrView',
				description:
					'Table functions are invoked with prepared scalar inputs, then queried through the same row governance controls',
				displayOptions: {
					show: { '@version': [{ _cnd: { gte: 1.4 } }], resource: ['rows'] },
				},
			},
			{
				displayName: 'Object Type',
				name: 'objectType',
				type: 'options',
				options: [
					{ name: 'Auto Detect', value: 'auto' },
					{ name: 'Table', value: 'table' },
					{ name: 'View', value: 'view' },
				],
				default: 'auto',
				displayOptions: {
					show: { resource: ['catalog'], operation: ['describeObject'] },
				},
			},
			{
				displayName: 'Table or View Name or ID',
				name: 'objectName',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getObjects',
					loadOptionsDependsOn: ['schema'],
				},
				default: '',
				required: true,
				description:
					'Approved table or view. The list is filtered by Allowed Objects when configured. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						resource: ['catalog'],
						operation: ['describeObject', 'listConstraints'],
					},
				},
			},
			{
				displayName: 'Runtime Object Name',
				name: 'objectName',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'ZN8NCOUNTRYP',
				description:
					'Exact HANA runtime name. Use List Tables and Views or List Table Functions / Parameterized CDS to discover it.',
				displayOptions: {
					show: {
						resource: ['catalog'],
						operation: ['inspectSemanticView', 'listSemanticParameters'],
					},
				},
			},
			{
				displayName: 'Table Function / Parameterized CDS Name or ID',
				name: 'functionName',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getTableFunctions',
					loadOptionsDependsOn: ['schema'],
				},
				default: '',
				required: true,
				description: 'Approved valid HANA table function or generated runtime function for a parameterized ABAP CDS. Custom Y/Z names are prioritized. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: { resource: ['catalog'], operation: ['describeTableFunction'] },
				},
			},
			{
				displayName: 'Table or View Name or ID',
				name: 'objectName',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getObjects',
					loadOptionsDependsOn: ['schema'],
				},
				default: '',
				required: true,
				description:
					'Approved table or view. The list is filtered by Allowed Objects when configured. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: { show: { resource: ['rows'], sourceKind: ['tableOrView'] } },
			},
			{
				displayName: 'Table Function / Parameterized CDS Name or ID',
				name: 'functionName',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getTableFunctions',
					loadOptionsDependsOn: ['schema'],
				},
				default: '',
				required: true,
				description:
					'Approved valid HANA table function or generated runtime function for a parameterized ABAP CDS. Custom Y/Z names are prioritized. It must also be present in Allowed Objects when that policy is configured. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.4 } }],
						resource: ['rows'],
						sourceKind: ['tableFunction'],
					},
				},
			},
			{
				displayName: 'Runtime View Parameters',
				name: 'semanticParameterMode',
				type: 'options',
				options: [
					{ name: 'Auto Detect (Recommended)', value: 'auto' },
					{ name: 'Calculation View Placeholders', value: 'calculationPlaceholders' },
					{ name: 'No Input Parameters', value: 'none' },
					{
						name: 'Positional SQL / Virtual CDS View Parameters',
						value: 'sqlPositional',
					},
				],
				default: 'auto',
				description:
					'How to call a parameterized HANA runtime view. ABAP CDS source and CDS view entities without a SQL or virtual view are not executed directly.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.3 } }],
						resource: ['rows'],
						sourceKind: ['tableOrView'],
					},
				},
			},
			{
				displayName: 'Semantic View Parameters',
				name: 'semanticParameters',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Input Parameter',
				description:
					'Values are bound as prepared-statement parameters. Calculation views also require the placeholder name without dollar signs.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.3 } }],
						resource: ['rows'],
						sourceKind: ['tableOrView'],
						semanticParameterMode: ['auto', 'calculationPlaceholders', 'sqlPositional'],
					},
				},
				options: [
					{
						displayName: 'Values',
						name: 'values',
						values: [
							{
								displayName: 'Placeholder Name',
								name: 'name',
								type: 'string',
								default: '',
								placeholder: 'P_COMPANY_CODE',
								description:
									'Calculation view placeholder name without the surrounding dollar signs; ignored for positional parameters',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								required: true,
							},
							{
								displayName: 'Value Type',
								name: 'valueType',
								type: 'options',
								options: [
									{ name: 'Boolean', value: 'boolean' },
									{ name: 'Number', value: 'number' },
									{ name: 'String / Date / Timestamp', value: 'string' },
								],
								default: 'string',
							},
						],
					},
				],
			},
			{
				displayName: 'Table Function Inputs',
				name: 'tableFunctionParameters',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Function Input',
				description:
					'Add every scalar input declared by the function. Names are matched case-insensitively and values are bound in catalog order.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.4 } }],
						resource: ['rows'],
						sourceKind: ['tableFunction'],
					},
				},
				options: [
					{
						displayName: 'Values',
						name: 'values',
						values: [
							{
								displayName: 'Parameter Name or ID',
								name: 'name',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getTableFunctionParameters',
									loadOptionsDependsOn: ['schema', 'functionName'],
								},
								default: '',
								required: true,
								description: 'Catalog-declared scalar input parameter. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								required: true,
							},
							{
								displayName: 'Value Type',
								name: 'valueType',
								type: 'options',
								options: [
									{ name: 'Boolean', value: 'boolean' },
									{ name: 'Null', value: 'null' },
									{ name: 'Number', value: 'number' },
									{ name: 'String / Date / Timestamp', value: 'string' },
								],
								default: 'string',
							},
						],
					},
				],
			},
			{
				displayName: 'Columns',
				name: 'columns',
				type: 'string',
				default: '*',
				description: 'Comma-separated column names, or * for all columns',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { lte: 1.2 } }],
						resource: ['rows'],
						operation: ['select', 'getByKey'],
					},
				},
			},
			{
				displayName: 'Selected Column Names or IDs',
				name: 'selectedColumns',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getColumns',
					loadOptionsDependsOn: ['schema', 'sourceKind', 'objectName', 'functionName'],
				},
				default: [],
				description:
					'Approved columns to return. Leave empty to return every column allowed by the credential policy. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.3 } }],
						resource: ['rows'],
						operation: ['select', 'getByKey', 'preview', 'distinct'],
					},
				},
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
				displayOptions: {
					show: {
						resource: ['rows'],
						operation: ['select', 'aggregate', 'exists', 'count', 'preview', 'distinct'],
					},
				},
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Filter',
				displayOptions: {
					show: {
						resource: ['rows'],
						operation: ['select', 'aggregate', 'exists', 'count', 'preview', 'distinct'],
					},
				},
				options: [
					{
						displayName: 'Values',
						name: 'values',
						values: [
							{
								displayName: 'Column Name or ID',
								name: 'column',
								type: 'options',
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
								typeOptions: {
									loadOptionsMethod: 'getColumns',
									loadOptionsDependsOn: ['schema', 'sourceKind', 'objectName', 'functionName'],
								},
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
				displayName: 'Key Fields',
				name: 'keyFields',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Key Field',
				description:
					'One or more equality fields that identify a single row. Composite business keys are supported.',
				displayOptions: { show: { resource: ['rows'], operation: ['getByKey'] } },
				options: [
					{
						displayName: 'Values',
						name: 'values',
						values: [
							{
								displayName: 'Column Name or ID',
								name: 'column',
								type: 'options',
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
								typeOptions: {
									loadOptionsMethod: 'getColumns',
									loadOptionsDependsOn: ['schema', 'sourceKind', 'objectName', 'functionName'],
								},
								default: '',
								required: true,
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								required: true,
								description: 'Value bound to HANA as a prepared-statement parameter',
							},
							{
								displayName: 'Value Type',
								name: 'valueType',
								type: 'options',
								options: [
									{ name: 'Boolean', value: 'boolean' },
									{ name: 'Number', value: 'number' },
									{ name: 'String / Date / Timestamp', value: 'string' },
								],
								default: 'string',
							},
						],
					},
				],
			},
			{
				displayName: 'Fail If Not Found',
				name: 'failIfNotFound',
				type: 'boolean',
				default: true,
				description: 'Whether to stop the workflow when no row matches the complete key',
				displayOptions: { show: { resource: ['rows'], operation: ['getByKey'] } },
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
				displayOptions: {
					show: {
						'@version': [{ _cnd: { lte: 1.2 } }],
						resource: ['rows'],
						operation: ['select'],
					},
				},
			},
			{
				displayName: 'Pagination Mode',
				name: 'paginationMode',
				type: 'options',
				options: [
					{ name: 'Automatic (Bounded)', value: 'automatic' },
					{ name: 'Continue From Cursor Token', value: 'keysetContinue' },
					{ name: 'First Keyset Page', value: 'keysetFirst' },
					{ name: 'No Pagination', value: 'none' },
				],
				default: 'none',
				description:
					'Use a stable composite keyset cursor. Automatic mode follows pages only up to the configured row and page caps.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.3 } }],
						resource: ['rows'],
						operation: ['select'],
					},
				},
			},
			{
				displayName: 'Cursor Column Names or IDs',
				name: 'cursorColumns',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getColumns',
					loadOptionsDependsOn: ['schema', 'sourceKind', 'objectName', 'functionName'],
				},
				default: [],
				required: true,
				description:
					'Ordered unique key used for stable pagination, for example CHANGED_AT followed by DOCUMENT_ID. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.3 } }],
						resource: ['rows'],
						operation: ['select'],
						paginationMode: ['automatic', 'keysetFirst', 'keysetContinue'],
					},
				},
			},
			{
				displayName: 'Cursor Token',
				name: 'cursorToken',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				required: true,
				description: 'Opaque nextCursor token returned by the previous page',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.3 } }],
						resource: ['rows'],
						operation: ['select'],
						paginationMode: ['keysetContinue'],
					},
				},
			},
			{
				displayName: 'Automatic Maximum Rows',
				name: 'automaticMaxRows',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 10000 },
				default: 5000,
				description: 'Hard cap across every automatically fetched page',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.3 } }],
						resource: ['rows'],
						operation: ['select'],
						paginationMode: ['automatic'],
					},
				},
			},
			{
				displayName: 'Automatic Maximum Pages',
				name: 'automaticMaxPages',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100 },
				default: 50,
				description: 'Hard cap on database round trips during automatic pagination',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.3 } }],
						resource: ['rows'],
						operation: ['select'],
						paginationMode: ['automatic'],
					},
				},
			},
			{
				displayName: 'Cursor Column Name or ID',
				name: 'cursorColumn',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getColumns',
					loadOptionsDependsOn: ['schema', 'sourceKind', 'objectName', 'functionName'],
				},
				default: '',
				required: true,
				placeholder: 'CHANGED_AT',
				description:
					'Unique, sortable column used to continue after the previous page; include it in Columns. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { lte: 1.2 } }],
						resource: ['rows'],
						operation: ['select'],
						paginationMode: ['automatic', 'keysetFirst', 'keysetContinue'],
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
						paginationMode: ['automatic', 'keysetFirst', 'keysetContinue'],
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
						'@version': [{ _cnd: { lte: 1.2 } }],
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
						'@version': [{ _cnd: { lte: 1.2 } }],
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
								displayName: 'Column Name or ID',
								name: 'column',
								type: 'options',
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
								typeOptions: {
									loadOptionsMethod: 'getColumns',
									loadOptionsDependsOn: ['schema', 'sourceKind', 'objectName', 'functionName'],
								},
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
				displayOptions: {
					show: {
						'@version': [{ _cnd: { lte: 1.2 } }],
						resource: ['rows'],
						operation: ['aggregate'],
					},
				},
			},
			{
				displayName: 'Aggregate Column Name or ID',
				name: 'aggregateColumn',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getColumns',
					loadOptionsDependsOn: ['schema', 'sourceKind', 'objectName', 'functionName'],
				},
				default: '',
				required: true,
				description:
					'Numeric or comparable column to aggregate. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { lte: 1.2 } }],
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
				displayOptions: {
					show: {
						'@version': [{ _cnd: { lte: 1.2 } }],
						resource: ['rows'],
						operation: ['aggregate'],
					},
				},
			},
			{
				displayName: 'Group By',
				name: 'groupBy',
				type: 'string',
				default: '',
				placeholder: 'COMPANY_CODE,CURRENCY',
				description: 'Optional comma-separated grouping columns',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { lte: 1.2 } }],
						resource: ['rows'],
						operation: ['aggregate'],
					},
				},
			},
			{
				displayName: 'Aggregate Calculations',
				name: 'aggregates',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Calculation',
				description: 'Add up to ten aggregate calculations to the same governed query',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.3 } }],
						resource: ['rows'],
						operation: ['aggregate'],
					},
				},
				options: [
					{
						displayName: 'Values',
						name: 'values',
						values: [
							{
								displayName: 'Function',
								name: 'function',
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
							},
							{
								displayName: 'Column Name or ID',
								name: 'column',
								type: 'options',
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
								typeOptions: {
									loadOptionsMethod: 'getColumns',
									loadOptionsDependsOn: ['schema', 'sourceKind', 'objectName', 'functionName'],
								},
								default: '',
								displayOptions: { hide: { function: ['COUNT'] } },
							},
							{
								displayName: 'Result Alias',
								name: 'alias',
								type: 'string',
								default: 'RESULT',
								required: true,
							},
						],
					},
				],
			},
			{
				displayName: 'Group By Columns',
				name: 'groupByColumns',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getColumns',
					loadOptionsDependsOn: ['schema', 'sourceKind', 'objectName', 'functionName'],
				},
				default: [],
				description:
					'Approved columns used to group the aggregate results. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.3 } }],
						resource: ['rows'],
						operation: ['aggregate'],
					},
				},
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
			{
				displayName: 'Big Integer Output',
				name: 'bigIntMode',
				type: 'options',
				options: [
					{ name: 'String (Safe)', value: 'string' },
					{ name: 'Number (Fail If Unsafe)', value: 'number' },
				],
				default: 'string',
				description: 'How native HANA big integers are represented in JSON',
				displayOptions: { show: { '@version': [{ _cnd: { gte: 1.3 } }] } },
			},
			{
				displayName: 'Date and Timestamp Output',
				name: 'dateMode',
				type: 'options',
				options: [
					{ name: 'ISO 8601 String', value: 'iso' },
					{ name: 'Epoch Milliseconds', value: 'epochMilliseconds' },
				],
				default: 'iso',
				description: 'How Date objects returned by the HANA driver are represented',
				displayOptions: { show: { '@version': [{ _cnd: { gte: 1.3 } }] } },
			},
			{
				displayName: 'Binary Encoding',
				name: 'binaryEncoding',
				type: 'options',
				options: [
					{ name: 'Base64', value: 'base64' },
					{ name: 'Hexadecimal', value: 'hex' },
				],
				default: 'base64',
				description: 'How BLOB and binary buffers are represented in JSON output',
				displayOptions: { show: { '@version': [{ _cnd: { gte: 1.3 } }] } },
			},
			{
				displayName: 'Maximum Result Size (Bytes)',
				name: 'maxResultBytes',
				type: 'number',
				typeOptions: { minValue: 1024, maxValue: 52_428_800 },
				default: 10_485_760,
				description:
					'Hard serialized-size cap for this execution; reduce columns or rows when the result is too large',
				displayOptions: { show: { '@version': [{ _cnd: { gte: 1.3 } }] } },
			},
			{
				displayName: 'Output Mode',
				name: 'outputMode',
				type: 'options',
				options: [
					{
						name: 'Each Row as an Item',
						value: 'eachRow',
						description: 'Return one n8n item for every HANA row',
					},
					{
						name: 'All Rows in One Item',
						value: 'singleItem',
						description: 'Return one item containing the complete bounded result array',
					},
					{
						name: 'Add Rows to Input Item',
						value: 'addToInput',
						description: 'Keep the incoming item and add the bounded result array to it',
					},
				],
				default: 'eachRow',
				description: 'How HANA rows are represented in the n8n output',
				displayOptions: { show: { '@version': [{ _cnd: { gte: 1.2 } }] } },
			},
			{
				displayName: 'Result Field',
				name: 'resultField',
				type: 'string',
				default: 'hanaRows',
				required: true,
				description: 'Top-level field that receives the array of HANA rows',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.2 } }],
						outputMode: ['singleItem', 'addToInput'],
					},
				},
			},
		],
	};

	methods = {
		loadOptions: {
			async getSchemas(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const credentials = await this.getCredentials<HanaCredentials>('hanaSecureApi');
					validateGovernanceConfiguration(credentials);
					return await withHanaClient(
						credentials,
						async (session) => await loadSchemaOptions(session, credentials),
					);
				} catch (error) {
					throw new NodeOperationError(
						this.getNode(),
						error instanceof Error ? error : new Error(String(error)),
					);
				}
			},
			async getObjects(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const schema = String(this.getCurrentNodeParameter('schema') ?? '').trim();
				if (!schema) return [];
				try {
					const credentials = await this.getCredentials<HanaCredentials>('hanaSecureApi');
					validateGovernanceConfiguration(credentials);
					return await withHanaClient(
						credentials,
						async (session) => await loadObjectOptions(session, credentials, schema),
					);
				} catch (error) {
					throw new NodeOperationError(
						this.getNode(),
						error instanceof Error ? error : new Error(String(error)),
					);
				}
			},
			async getTableFunctions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const schema = String(this.getCurrentNodeParameter('schema') ?? '').trim();
				if (!schema) return [];
				try {
					const credentials = await this.getCredentials<HanaCredentials>('hanaSecureApi');
					validateGovernanceConfiguration(credentials);
					return await withHanaClient(
						credentials,
						async (session) => await loadTableFunctionOptions(session, credentials, schema),
					);
				} catch (error) {
					throw new NodeOperationError(
						this.getNode(),
						error instanceof Error ? error : new Error(String(error)),
					);
				}
			},
			async getTableFunctionParameters(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				const schema = String(this.getCurrentNodeParameter('schema') ?? '').trim();
				const functionName = String(
					this.getCurrentNodeParameter('functionName') ?? '',
				).trim();
				if (!schema || !functionName) return [];
				try {
					const credentials = await this.getCredentials<HanaCredentials>('hanaSecureApi');
					validateGovernanceConfiguration(credentials);
					return await withHanaClient(
						credentials,
						async (session) =>
							await loadTableFunctionParameterOptions(
								session,
								credentials,
								schema,
								functionName,
							),
					);
				} catch (error) {
					throw new NodeOperationError(
						this.getNode(),
						error instanceof Error ? error : new Error(String(error)),
					);
				}
			},
			async getColumns(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const schema = String(this.getCurrentNodeParameter('schema') ?? '').trim();
				const sourceKind = String(
					this.getCurrentNodeParameter('sourceKind') ?? 'tableOrView',
				);
				const objectName = String(
					this.getCurrentNodeParameter(
						sourceKind === 'tableFunction' ? 'functionName' : 'objectName',
					) ?? '',
				).trim();
				if (!schema || !objectName) return [];
				try {
					const credentials = await this.getCredentials<HanaCredentials>('hanaSecureApi');
					validateGovernanceConfiguration(credentials);
					return await withHanaClient(
						credentials,
						async (session) =>
							sourceKind === 'tableFunction'
								? await loadTableFunctionColumnOptions(
										session,
										credentials,
										schema,
										objectName,
									)
								: await loadColumnOptions(session, credentials, schema, objectName),
					);
				} catch (error) {
					throw new NodeOperationError(
						this.getNode(),
						error instanceof Error ? error : new Error(String(error)),
					);
				}
			},
		},
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
		if (inputItems.length === 0) return [outputItems];
		const credentials = (await this.getCredentials(
			'hanaSecureApi',
			0,
		)) as unknown as HanaCredentials;
		validateGovernanceConfiguration(credentials);

		await withHanaClient(credentials, async (session) => {
			for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex += 1) {
				try {
					const resource = this.getNodeParameter('resource', itemIndex) as string;
					const operation = this.getNodeParameter('operation', itemIndex) as string;
					const aiToolPolicy = resolveAiToolPolicy(
						this.getNode().type,
						this.getNode().typeVersion,
						resource,
						operation,
						credentials,
					);

					const result: Record<string, unknown>[] = await (async () => {
						if (resource === 'connection') {
							if (operation === 'getDatabaseInfo') {
								const rows = await session.query(
									'SELECT "SYSTEM_ID", "DATABASE_NAME", "VERSION", "USAGE", "START_TIME" FROM "SYS"."M_DATABASE"',
								);
								return rows.map((row) => ({
									...row,
									TLS_ENABLED: credentials.useTLS,
								}));
							}
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
						if (resource === 'governance') {
							const schemas = parseAllowedSchemas(credentials.allowedSchemas);
							const objects = [...parseAllowedObjects(credentials.allowedObjects)].sort();
							const columnPolicies = parseColumnPolicies(credentials.columnPoliciesJson);
							const requiredPolicies = parseRequiredFilterPolicies(credentials.requiredFiltersJson);
							return [
								{
									POLICY_VALID: true,
									ALLOWED_SCHEMAS: schemas,
									ALLOWED_OBJECTS: objects,
									COLUMN_POLICIES: Object.fromEntries(
										[...columnPolicies.entries()].map(([reference, columns]) => [
											reference,
											columns,
										]),
									),
									REQUIRED_FILTERS: Object.fromEntries(
										[...requiredPolicies.entries()].map(([reference, filters]) => [
											reference,
											filters.map((filter) => ({
												column: filter.column,
												operator: filter.operator,
												valueRedacted: true,
											})),
										]),
									),
									ADVANCED_SQL_ENABLED: credentials.allowAdvancedSql === true,
									AI_TOOL_ENABLED: credentials.allowAiTool === true,
									AI_CATALOG_DISCOVERY_ENABLED: credentials.allowAiCatalogDiscovery === true,
									AI_MAX_ROWS: credentials.aiToolMaxRows ?? 100,
									AI_MAX_BYTES: credentials.aiToolMaxBytes ?? 262_144,
								},
							];
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
					})();
					if (this.getNode().typeVersion >= 1.3 && result.length > 0) {
						const existingMetadata =
							result[0]._hana && typeof result[0]._hana === 'object'
								? (result[0]._hana as Record<string, unknown>)
								: {};
						result[0] = {
							...result[0],
							_hana: {
								...existingMetadata,
								...session.diagnostics(),
								connectionScope: 'execution',
								inputItemCount: inputItems.length,
							},
						};
					}

					const jsonResult = rowsToJson(
						result,
						this.getNode().typeVersion >= 1.3
							? {
									bigIntMode: this.getNodeParameter('bigIntMode', itemIndex, 'string') as
										| 'string'
										| 'number',
									binaryEncoding: this.getNodeParameter('binaryEncoding', itemIndex, 'base64') as
										| 'base64'
										| 'hex',
									dateMode: this.getNodeParameter('dateMode', itemIndex, 'iso') as
										| 'iso'
										| 'epochMilliseconds',
								}
							: {},
					);
					if (this.getNode().typeVersion >= 1.3) {
						enforceJsonByteLimit(
							jsonResult,
							this.getNodeParameter('maxResultBytes', itemIndex, 10_485_760) as number,
						);
					}
					enforceAiToolByteLimit(jsonResult, aiToolPolicy.maxBytes);
					const outputMode =
						this.getNode().typeVersion >= 1.2
							? (this.getNodeParameter('outputMode', itemIndex, 'eachRow') as HanaOutputMode)
							: 'eachRow';
					const resultField =
						outputMode === 'eachRow'
							? 'hanaRows'
							: (this.getNodeParameter('resultField', itemIndex, 'hanaRows') as string);
					outputItems.push(
						...formatHanaOutput(
							inputItems[itemIndex],
							jsonResult,
							itemIndex,
							outputMode,
							resultField,
						),
					);
				} catch (error) {
					if (this.continueOnFail()) {
						outputItems.push({
							json: hanaErrorOutput(error) as INodeExecutionData['json'],
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
		});

		return [outputItems];
	}
}
