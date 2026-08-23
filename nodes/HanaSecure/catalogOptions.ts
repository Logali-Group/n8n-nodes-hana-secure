import type { INodePropertyOptions } from 'n8n-workflow';

import {
	allowedColumnsForObject,
	allowedObjectNamesForSchema,
	assertObjectAllowed,
	isObjectAllowed,
	parseAllowedObjects,
	parseColumnPolicies,
	resolveSchemaName,
} from './governance';
import type { HanaSession } from './hanaClient';
import { assertIdentifier, assertSchemaAllowed, parseAllowedSchemas } from './sqlSafety';
import type { HanaCredentials } from './types';

const MAX_DYNAMIC_OPTIONS = 500;

export async function loadTableFunctionOptions(
	session: HanaSession,
	credentials: HanaCredentials,
	rawSchema: string,
): Promise<INodePropertyOptions[]> {
	const allowedSchemas = parseAllowedSchemas(credentials.allowedSchemas);
	const allowedObjects = parseAllowedObjects(credentials.allowedObjects);
	const schema = assertSchemaAllowed(rawSchema, allowedSchemas);
	const governedNames = allowedObjectNamesForSchema(schema, allowedObjects);
	if (governedNames?.length === 0) return [];
	const namePredicate = governedNames
		? ` AND "FUNCTION_NAME" IN (${governedNames.map(() => '?').join(', ')})`
		: '';
	const rows = await session.query(
		`SELECT "FUNCTION_NAME", "SQL_SECURITY", "INPUT_PARAMETER_COUNT"
FROM "SYS"."FUNCTIONS"
WHERE "SCHEMA_NAME" = ? AND "FUNCTION_USAGE_TYPE" = 'TABLE' AND "IS_VALID" = 'TRUE'${namePredicate}
ORDER BY CASE
	WHEN "FUNCTION_NAME" LIKE 'Z%' OR "FUNCTION_NAME" LIKE 'Y%' THEN 0
	WHEN "FUNCTION_NAME" LIKE '/%' THEN 1
	ELSE 2
END, "FUNCTION_NAME"
LIMIT ${MAX_DYNAMIC_OPTIONS + 1}`,
		governedNames ? [schema, ...governedNames] : [schema],
	);
	return rows
		.filter((row) => isObjectAllowed(schema, String(row.FUNCTION_NAME), allowedObjects))
		.slice(0, MAX_DYNAMIC_OPTIONS)
		.map((row) => ({
			name: `${String(row.FUNCTION_NAME)} (table function / parameterized CDS)`,
			value: String(row.FUNCTION_NAME),
			description: `${String(row.INPUT_PARAMETER_COUNT ?? 0)} input parameter(s); SQL security ${String(row.SQL_SECURITY ?? 'UNKNOWN')}`,
		}));
}

export async function loadTableFunctionParameterOptions(
	session: HanaSession,
	credentials: HanaCredentials,
	rawSchema: string,
	rawFunctionName: string,
): Promise<INodePropertyOptions[]> {
	const allowedSchemas = parseAllowedSchemas(credentials.allowedSchemas);
	const allowedObjects = parseAllowedObjects(credentials.allowedObjects);
	const schema = assertSchemaAllowed(rawSchema, allowedSchemas);
	const functionName = assertIdentifier(rawFunctionName, 'function name');
	assertObjectAllowed(schema, functionName, allowedObjects);
	const rows = await session.query(
		`SELECT "PARAMETER_NAME", "DATA_TYPE_NAME", "POSITION"
FROM "SYS"."FUNCTION_PARAMETERS"
WHERE "SCHEMA_NAME" = ? AND "FUNCTION_NAME" = ? AND "PARAMETER_TYPE" IN ('IN', 'INOUT')
ORDER BY "POSITION"`,
		[schema, functionName],
	);
	return rows.slice(0, 20).map((row) => ({
		name: `${String(row.PARAMETER_NAME)} (${String(row.DATA_TYPE_NAME)})`,
		value: String(row.PARAMETER_NAME),
	}));
}

export async function loadSchemaOptions(
	session: HanaSession,
	credentials: HanaCredentials,
): Promise<INodePropertyOptions[]> {
	const allowedSchemas = parseAllowedSchemas(credentials.allowedSchemas);
	const allowedObjects = parseAllowedObjects(credentials.allowedObjects);
	const rows = await session.query(
		`SELECT "SCHEMA_NAME" FROM "SYS"."SCHEMAS"
WHERE "SCHEMA_NAME" <> 'SYS' AND "SCHEMA_NAME" NOT LIKE '\\_SYS\\_%' ESCAPE '\\'
ORDER BY "SCHEMA_NAME"`,
	);

	const defaultSchema = credentials.defaultSchema?.trim().toUpperCase();
	return rows
		.filter((row) => {
			const schema = String(row.SCHEMA_NAME);
			if (allowedSchemas.length > 0 && !allowedSchemas.includes(schema.toUpperCase())) return false;
			if (allowedObjects.size === 0) return true;
			const prefix = `${schema.toUpperCase()}.`;
			return [...allowedObjects].some((reference) => reference.startsWith(prefix));
		})
		.sort((left, right) => {
			const leftIsDefault = String(left.SCHEMA_NAME).toUpperCase() === defaultSchema;
			const rightIsDefault = String(right.SCHEMA_NAME).toUpperCase() === defaultSchema;
			if (leftIsDefault === rightIsDefault) {
				return String(left.SCHEMA_NAME).localeCompare(String(right.SCHEMA_NAME));
			}
			return leftIsDefault ? -1 : 1;
		})
		.slice(0, MAX_DYNAMIC_OPTIONS)
		.map((row) => {
			const schema = String(row.SCHEMA_NAME);
			return {
				name: schema.toUpperCase() === defaultSchema ? `${schema} (credential default)` : schema,
				value: schema,
			};
		});
}

export function schemaForEditor(
	rawSchema: string | undefined,
	credentials: HanaCredentials,
): string | undefined {
	if (!rawSchema?.trim() && !credentials.defaultSchema?.trim()) return undefined;
	return resolveSchemaName(rawSchema, credentials);
}

export async function loadObjectOptions(
	session: HanaSession,
	credentials: HanaCredentials,
	rawSchema: string,
): Promise<INodePropertyOptions[]> {
	const allowedSchemas = parseAllowedSchemas(credentials.allowedSchemas);
	const allowedObjects = parseAllowedObjects(credentials.allowedObjects);
	const schema = assertSchemaAllowed(rawSchema, allowedSchemas);
	const governedNames = allowedObjectNamesForSchema(schema, allowedObjects);
	if (governedNames?.length === 0) return [];

	const objectPredicate = governedNames
		? ` AND "TABLE_NAME" IN (${governedNames.map(() => '?').join(', ')})`
		: '';
	const viewPredicate = governedNames
		? ` AND "VIEW_NAME" IN (${governedNames.map(() => '?').join(', ')})`
		: '';
	const parameters = governedNames
		? [schema, ...governedNames, schema, ...governedNames]
		: [schema, schema];
	const rows = await session.query(
		`SELECT "TABLE_NAME" AS "OBJECT_NAME", CASE WHEN "TABLE_TYPE" = 'VIRTUAL' THEN 'VIRTUAL_TABLE' ELSE 'TABLE' END AS "OBJECT_TYPE", NULL AS "VIEW_TYPE", CASE WHEN "TABLE_TYPE" = 'VIRTUAL' THEN 'UNKNOWN' ELSE 'FALSE' END AS "HAS_PARAMETERS"
FROM "SYS"."TABLES" WHERE "SCHEMA_NAME" = ?${objectPredicate}
UNION ALL
SELECT "VIEW_NAME" AS "OBJECT_NAME", 'VIEW' AS "OBJECT_TYPE", "VIEW_TYPE", "HAS_PARAMETERS"
FROM "SYS"."VIEWS" WHERE "SCHEMA_NAME" = ?${viewPredicate}
ORDER BY "OBJECT_TYPE", "OBJECT_NAME"
LIMIT ${MAX_DYNAMIC_OPTIONS + 1}`,
		parameters,
	);

	return rows
		.filter((row) => isObjectAllowed(schema, String(row.OBJECT_NAME), allowedObjects))
		.slice(0, MAX_DYNAMIC_OPTIONS)
		.map((row) => {
			const isCalculationView = String(row.VIEW_TYPE).toUpperCase() === 'CALC';
			const objectLabel = isCalculationView
				? 'calculation view'
				: String(row.OBJECT_TYPE).toUpperCase() === 'VIRTUAL_TABLE'
					? 'virtual table'
					: String(row.OBJECT_TYPE).toLowerCase();
			return {
				name: `${String(row.OBJECT_NAME)} (${objectLabel})`,
				value: String(row.OBJECT_NAME),
				description:
					String(row.OBJECT_TYPE).toUpperCase() === 'VIRTUAL_TABLE'
						? 'HANA virtual table; it may expose a remote CDS or parameterized runtime object'
						: String(row.HAS_PARAMETERS).toUpperCase() === 'TRUE'
							? 'Parameterized HANA runtime view'
							: `HANA ${objectLabel}`,
			};
		});
}

export async function loadColumnOptions(
	session: HanaSession,
	credentials: HanaCredentials,
	rawSchema: string,
	rawObjectName: string,
): Promise<INodePropertyOptions[]> {
	const allowedSchemas = parseAllowedSchemas(credentials.allowedSchemas);
	const allowedObjects = parseAllowedObjects(credentials.allowedObjects);
	const columnPolicies = parseColumnPolicies(credentials.columnPoliciesJson);
	const schema = assertSchemaAllowed(rawSchema, allowedSchemas);
	const objectName = assertIdentifier(rawObjectName, 'object name');
	assertObjectAllowed(schema, objectName, allowedObjects);

	const rows = await session.query(
		`SELECT "COLUMN_NAME", "DATA_TYPE_NAME", "POSITION"
FROM "SYS"."TABLE_COLUMNS" AS "TC"
WHERE "SCHEMA_NAME" = ? AND "TABLE_NAME" = ?
AND NOT EXISTS (
	SELECT 1 FROM "SYS"."VIRTUAL_TABLES" AS "VT"
	WHERE "VT"."SCHEMA_NAME" = "TC"."SCHEMA_NAME" AND "VT"."TABLE_NAME" = "TC"."TABLE_NAME"
)
UNION ALL
SELECT "COLUMN_NAME", "DATA_TYPE_NAME", "POSITION"
FROM "SYS"."VIEW_COLUMNS" WHERE "SCHEMA_NAME" = ? AND "VIEW_NAME" = ?
UNION ALL
SELECT "COLUMN_NAME", "DATA_TYPE_NAME", 0 AS "POSITION"
FROM "SYS"."VIRTUAL_COLUMNS" WHERE "SCHEMA_NAME" = ? AND "TABLE_NAME" = ?
ORDER BY "POSITION", "COLUMN_NAME"`,
		[schema, objectName, schema, objectName, schema, objectName],
	);
	const allowedColumns = allowedColumnsForObject(schema, objectName, columnPolicies);
	const allowed = allowedColumns
		? new Set(allowedColumns.map((column) => column.toUpperCase()))
		: undefined;

	return rows
		.filter((row) => !allowed || allowed.has(String(row.COLUMN_NAME).toUpperCase()))
		.slice(0, MAX_DYNAMIC_OPTIONS)
		.map((row) => ({
			name: `${String(row.COLUMN_NAME)} (${String(row.DATA_TYPE_NAME)})`,
			value: String(row.COLUMN_NAME),
		}));
}

export async function loadTableFunctionColumnOptions(
	session: HanaSession,
	credentials: HanaCredentials,
	rawSchema: string,
	rawFunctionName: string,
): Promise<INodePropertyOptions[]> {
	const allowedSchemas = parseAllowedSchemas(credentials.allowedSchemas);
	const allowedObjects = parseAllowedObjects(credentials.allowedObjects);
	const columnPolicies = parseColumnPolicies(credentials.columnPoliciesJson);
	const schema = assertSchemaAllowed(rawSchema, allowedSchemas);
	const functionName = assertIdentifier(rawFunctionName, 'function name');
	assertObjectAllowed(schema, functionName, allowedObjects);
	const rows = await session.query(
		`SELECT "COLUMN_NAME", "DATA_TYPE_NAME", "POSITION"
FROM "SYS"."FUNCTION_PARAMETER_COLUMNS"
WHERE "SCHEMA_NAME" = ? AND "FUNCTION_NAME" = ?
ORDER BY "PARAMETER_POSITION", "POSITION"`,
		[schema, functionName],
	);
	const allowedColumns = allowedColumnsForObject(schema, functionName, columnPolicies);
	const allowed = allowedColumns
		? new Set(allowedColumns.map((column) => column.toUpperCase()))
		: undefined;
	return rows
		.filter((row) => !allowed || allowed.has(String(row.COLUMN_NAME).toUpperCase()))
		.slice(0, MAX_DYNAMIC_OPTIONS)
		.map((row) => ({
			name: `${String(row.COLUMN_NAME)} (${String(row.DATA_TYPE_NAME)})`,
			value: String(row.COLUMN_NAME),
		}));
}
