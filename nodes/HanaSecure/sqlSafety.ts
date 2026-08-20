import { OperationalError } from 'n8n-workflow';

import type { Filter, FilterLogic, FilterValueType, OrderBy, UiFilter, UiKeyField } from './types';

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$#]*$/;
const FORBIDDEN_SQL_KEYWORDS = [
	'ALTER',
	'BACKUP',
	'CALL',
	'COMMENT',
	'CREATE',
	'DELETE',
	'DO',
	'DROP',
	'EXEC',
	'EXECUTE',
	'EXPORT',
	'GRANT',
	'IMPORT',
	'INSERT',
	'LOAD',
	'LOCK',
	'MERGE',
	'RECOVER',
	'RENAME',
	'REPLACE',
	'RESET',
	'REVOKE',
	'SET',
	'TRANSACTION',
	'TRUNCATE',
	'UNLOAD',
	'UPDATE',
	'UPSERT',
] as const;

export function assertIdentifier(identifier: string, label = 'identifier'): string {
	const value = identifier.trim();
	if (!IDENTIFIER_PATTERN.test(value)) {
		throw new Error(
			`Invalid ${label}. Use letters, numbers, underscore, dollar sign, or hash, and do not start with a number.`,
		);
	}
	return value;
}

export function quoteIdentifier(identifier: string, label?: string): string {
	return `"${assertIdentifier(identifier, label)}"`;
}

export function parseIdentifierList(value: string, label: string): string[] {
	const identifiers = value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => assertIdentifier(entry, label));

	if (identifiers.length === 0) {
		throw new Error(`At least one ${label} is required.`);
	}

	return [...new Set(identifiers)];
}

export function parseAllowedSchemas(value?: string): string[] {
	if (!value?.trim()) return [];
	return parseIdentifierList(value, 'allowed schema').map((schema) => schema.toUpperCase());
}

export function assertSchemaAllowed(schema: string, allowlist: string[]): string {
	const checkedSchema = assertIdentifier(schema, 'schema');
	if (
		allowlist.length > 0 &&
		!allowlist.some((allowedSchema) => allowedSchema === checkedSchema.toUpperCase())
	) {
		throw new Error(`Schema "${checkedSchema}" is not allowed by these credentials.`);
	}
	return checkedSchema;
}

const MAX_FILTER_LIST_VALUES = 100;

function escapeLikeLiteral(value: unknown): string {
	return String(value ?? '').replace(/[\\%_]/g, '\\$&');
}

function listValue(filter: Filter): unknown[] {
	if (!Array.isArray(filter.value)) {
		throw new Error(`Filter operator ${filter.operator} requires an array value.`);
	}
	if (filter.operator === 'between' && filter.value.length !== 2) {
		throw new Error('Between requires exactly two values.');
	}
	if (filter.operator !== 'between' && filter.value.length === 0) {
		throw new Error(`${filter.operator} requires at least one value.`);
	}
	if (filter.value.length > MAX_FILTER_LIST_VALUES) {
		throw new Error(`A filter may contain at most ${MAX_FILTER_LIST_VALUES} values.`);
	}
	return filter.value;
}

export function buildWhereClause(
	filters: Filter[],
	logic: FilterLogic = 'AND',
): {
	sql: string;
	parameters: unknown[];
} {
	if (filters.length === 0) return { sql: '', parameters: [] };

	const parameters: unknown[] = [];
	const predicates = filters.map((filter) => {
		const column = quoteIdentifier(filter.column, 'filter column');
		switch (filter.operator) {
			case 'eq':
				parameters.push(filter.value);
				return `${column} = ?`;
			case 'ne':
				parameters.push(filter.value);
				return `${column} <> ?`;
			case 'gt':
				parameters.push(filter.value);
				return `${column} > ?`;
			case 'ge':
				parameters.push(filter.value);
				return `${column} >= ?`;
			case 'lt':
				parameters.push(filter.value);
				return `${column} < ?`;
			case 'le':
				parameters.push(filter.value);
				return `${column} <= ?`;
			case 'like':
				parameters.push(filter.value);
				return `${column} LIKE ?`;
			case 'notLike':
				parameters.push(filter.value);
				return `${column} NOT LIKE ?`;
			case 'contains':
				parameters.push(`%${escapeLikeLiteral(filter.value)}%`);
				return `${column} LIKE ? ESCAPE '\\'`;
			case 'startsWith':
				parameters.push(`${escapeLikeLiteral(filter.value)}%`);
				return `${column} LIKE ? ESCAPE '\\'`;
			case 'endsWith':
				parameters.push(`%${escapeLikeLiteral(filter.value)}`);
				return `${column} LIKE ? ESCAPE '\\'`;
			case 'in': {
				const values = listValue(filter);
				parameters.push(...values);
				return `${column} IN (${values.map(() => '?').join(', ')})`;
			}
			case 'notIn': {
				const values = listValue(filter);
				parameters.push(...values);
				return `${column} NOT IN (${values.map(() => '?').join(', ')})`;
			}
			case 'between': {
				const values = listValue(filter);
				parameters.push(...values);
				return `${column} BETWEEN ? AND ?`;
			}
			case 'isNull':
				return `${column} IS NULL`;
			case 'isNotNull':
				return `${column} IS NOT NULL`;
			default:
				throw new Error(`Unsupported filter operator: ${String(filter.operator)}`);
		}
	});

	const checkedLogic = logic === 'OR' ? 'OR' : 'AND';
	return { sql: ` WHERE ${predicates.join(` ${checkedLogic} `)}`, parameters };
}

export function combineWhereClauses(...clauses: Array<{ sql: string; parameters: unknown[] }>): {
	sql: string;
	parameters: unknown[];
} {
	const populated = clauses.filter((clause) => clause.sql);
	if (populated.length === 0) return { sql: '', parameters: [] };
	return {
		sql: ` WHERE ${populated.map((clause) => `(${clause.sql.replace(/^ WHERE /, '')})`).join(' AND ')}`,
		parameters: populated.flatMap((clause) => clause.parameters),
	};
}

function typedValue(value: unknown, valueType: FilterValueType): unknown {
	if (valueType === 'string') return String(value ?? '');
	if (valueType === 'number') {
		const parsed = Number(value);
		if (!Number.isFinite(parsed))
			throw new Error(`Filter value "${String(value)}" is not a number.`);
		return parsed;
	}
	if (valueType === 'boolean') {
		if (value === true || value === 'true') return true;
		if (value === false || value === 'false') return false;
		throw new Error('Boolean filter values must be true or false.');
	}
	if (valueType === 'null') return null;
	return value;
}

export function normalizeUiFilters(filters: UiFilter[]): Filter[] {
	return filters.map((filter) => {
		if (filter.operator === 'isNull' || filter.operator === 'isNotNull') {
			return { column: filter.column, operator: filter.operator };
		}
		const valueType = filter.valueType ?? 'string';
		if (valueType === 'null') {
			if (filter.operator === 'eq') return { column: filter.column, operator: 'isNull' };
			if (filter.operator === 'ne') return { column: filter.column, operator: 'isNotNull' };
			throw new Error('Null values may be used only with Equals or Not Equals.');
		}
		if (filter.operator === 'in' || filter.operator === 'notIn' || filter.operator === 'between') {
			let parsed: unknown;
			let parseFailed = false;
			try {
				parsed = JSON.parse(filter.valuesJson || '[]');
			} catch {
				parseFailed = true;
			}
			if (parseFailed) throw new Error(`${filter.operator} values must be a valid JSON array.`);
			if (!Array.isArray(parsed))
				throw new Error(`${filter.operator} values must be a JSON array.`);
			return {
				column: filter.column,
				operator: filter.operator,
				value: parsed.map((value) =>
					typedValue(value, valueType === 'json' ? 'string' : valueType),
				),
			};
		}
		if (valueType === 'json') {
			throw new Error('JSON value type is available only for IN, NOT IN, and BETWEEN.');
		}
		return {
			column: filter.column,
			operator: filter.operator,
			value: typedValue(filter.value, valueType),
		};
	});
}

export function normalizeUiKeyFields(keyFields: UiKeyField[]): Filter[] {
	if (keyFields.length === 0) {
		throw new Error('Get One by Key requires at least one key field.');
	}
	const uniqueColumns = new Set<string>();
	return keyFields.map((field) => {
		const column = assertIdentifier(field.column, 'key column');
		const normalizedColumn = column.toUpperCase();
		if (uniqueColumns.has(normalizedColumn)) {
			throw new Error('Each key column may be configured only once.');
		}
		uniqueColumns.add(normalizedColumn);
		return {
			column,
			operator: 'eq',
			value: typedValue(field.value, field.valueType ?? 'string'),
		};
	});
}

export function parseTypedValue(value: unknown, valueType: FilterValueType): unknown {
	if (valueType === 'json') throw new Error('A cursor value cannot use the JSON value type.');
	if (valueType === 'null') throw new Error('A cursor value cannot be null.');
	return typedValue(value, valueType);
}

export function buildOrderByClause(orderBy: OrderBy[]): string {
	if (orderBy.length === 0) return '';
	const values = orderBy.map(({ column, direction }) => {
		const checkedDirection = direction === 'DESC' ? 'DESC' : 'ASC';
		return `${quoteIdentifier(column, 'sort column')} ${checkedDirection}`;
	});
	return ` ORDER BY ${values.join(', ')}`;
}

export function parseParametersJson(value: string): unknown[] {
	let parameters: unknown;
	try {
		parameters = JSON.parse(value || '[]');
	} catch {
		// Converted to NodeOperationError by the execute boundary, which has the node context.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		throw new OperationalError('Parameters JSON must be a valid JSON array.');
	}
	if (!Array.isArray(parameters)) {
		throw new Error('Parameters JSON must be an array.');
	}
	for (const parameter of parameters) {
		if (
			parameter !== null &&
			typeof parameter !== 'string' &&
			typeof parameter !== 'number' &&
			typeof parameter !== 'boolean'
		) {
			throw new Error('SQL parameters may contain only strings, numbers, booleans, or null.');
		}
	}
	return parameters;
}

function inspectSql(sql: string): {
	normalized: string;
	placeholderCount: number;
	hasSemicolon: boolean;
	hasComment: boolean;
} {
	let normalized = '';
	let placeholderCount = 0;
	let hasSemicolon = false;
	let hasComment = false;
	let inSingleQuote = false;
	let inDoubleQuote = false;

	for (let index = 0; index < sql.length; index += 1) {
		const character = sql[index];
		const nextCharacter = sql[index + 1];

		if (inSingleQuote) {
			if (character === "'" && nextCharacter === "'") {
				index += 1;
			} else if (character === "'") {
				inSingleQuote = false;
			}
			normalized += ' ';
			continue;
		}

		if (inDoubleQuote) {
			if (character === '"' && nextCharacter === '"') {
				index += 1;
			} else if (character === '"') {
				inDoubleQuote = false;
			}
			normalized += ' ';
			continue;
		}

		if (character === "'") {
			inSingleQuote = true;
			normalized += ' ';
			continue;
		}
		if (character === '"') {
			inDoubleQuote = true;
			normalized += ' ';
			continue;
		}
		if (character === '-' && nextCharacter === '-') hasComment = true;
		if (character === '/' && nextCharacter === '*') hasComment = true;
		if (character === ';') hasSemicolon = true;
		if (character === '?') placeholderCount += 1;
		normalized += character;
	}

	if (inSingleQuote || inDoubleQuote) throw new Error('SQL contains an unclosed quoted value.');
	return { normalized, placeholderCount, hasSemicolon, hasComment };
}

export function validateAdvancedSelect(
	sql: string,
	parameters: unknown[],
	rowLimit: number,
): string {
	const trimmedSql = sql.trim();
	if (!trimmedSql) throw new Error('SQL statement is required.');

	const inspection = inspectSql(trimmedSql);
	const normalizedUpper = inspection.normalized.toUpperCase();
	if (!/^SELECT\b/.test(normalizedUpper)) {
		throw new Error('Advanced SQL accepts only a single SELECT statement.');
	}
	if (inspection.hasSemicolon) {
		throw new Error('Semicolons are not allowed in advanced SQL.');
	}
	if (inspection.hasComment) {
		throw new Error('SQL comments are not allowed in advanced SQL.');
	}
	if (inspection.placeholderCount !== parameters.length) {
		throw new Error(
			`The SQL contains ${inspection.placeholderCount} placeholder(s), but ${parameters.length} parameter(s) were provided.`,
		);
	}
	if (/\b(?:LIMIT|TOP)\b/.test(normalizedUpper)) {
		throw new Error('Do not add LIMIT or TOP. The node enforces its own hard row limit.');
	}
	for (const keyword of FORBIDDEN_SQL_KEYWORDS) {
		if (new RegExp(`\\b${keyword}\\b`).test(normalizedUpper)) {
			throw new Error(`Keyword ${keyword} is not allowed in advanced SQL.`);
		}
	}

	return `${trimmedSql} LIMIT ${rowLimit + 1}`;
}
