import type { INodePropertyOptions } from 'n8n-workflow';

import {
	allowedColumnsForObject,
	allowedObjectNamesForSchema,
	assertObjectAllowed,
	isObjectAllowed,
	parseAllowedObjects,
	parseColumnPolicies,
} from './governance';
import type { HanaSession } from './hanaClient';
import { assertIdentifier, assertSchemaAllowed, parseAllowedSchemas } from './sqlSafety';
import type { HanaCredentials } from './types';

const MAX_DYNAMIC_OPTIONS = 500;

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

	return rows
		.filter((row) => {
			const schema = String(row.SCHEMA_NAME);
			if (allowedSchemas.length > 0 && !allowedSchemas.includes(schema.toUpperCase())) return false;
			if (allowedObjects.size === 0) return true;
			const prefix = `${schema.toUpperCase()}.`;
			return [...allowedObjects].some((reference) => reference.startsWith(prefix));
		})
		.slice(0, MAX_DYNAMIC_OPTIONS)
		.map((row) => ({ name: String(row.SCHEMA_NAME), value: String(row.SCHEMA_NAME) }));
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
		`SELECT "TABLE_NAME" AS "OBJECT_NAME", 'TABLE' AS "OBJECT_TYPE"
FROM "SYS"."TABLES" WHERE "SCHEMA_NAME" = ?${objectPredicate}
UNION ALL
SELECT "VIEW_NAME" AS "OBJECT_NAME", 'VIEW' AS "OBJECT_TYPE"
FROM "SYS"."VIEWS" WHERE "SCHEMA_NAME" = ?${viewPredicate}
ORDER BY "OBJECT_TYPE", "OBJECT_NAME"
LIMIT ${MAX_DYNAMIC_OPTIONS + 1}`,
		parameters,
	);

	return rows
		.filter((row) => isObjectAllowed(schema, String(row.OBJECT_NAME), allowedObjects))
		.slice(0, MAX_DYNAMIC_OPTIONS)
		.map((row) => ({
			name: `${String(row.OBJECT_NAME)} (${String(row.OBJECT_TYPE).toLowerCase()})`,
			value: String(row.OBJECT_NAME),
		}));
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
FROM "SYS"."TABLE_COLUMNS" WHERE "SCHEMA_NAME" = ? AND "TABLE_NAME" = ?
UNION ALL
SELECT "COLUMN_NAME", "DATA_TYPE_NAME", "POSITION"
FROM "SYS"."VIEW_COLUMNS" WHERE "SCHEMA_NAME" = ? AND "VIEW_NAME" = ?
ORDER BY "POSITION"`,
		[schema, objectName, schema, objectName],
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
