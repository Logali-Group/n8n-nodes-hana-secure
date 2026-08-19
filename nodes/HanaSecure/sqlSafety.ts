import { OperationalError } from 'n8n-workflow';

import type { Filter, OrderBy } from './types';

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

export function buildWhereClause(filters: Filter[]): {
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
			case 'isNull':
				return `${column} IS NULL`;
			case 'isNotNull':
				return `${column} IS NOT NULL`;
			default:
				throw new Error(`Unsupported filter operator: ${String(filter.operator)}`);
		}
	});

	return { sql: ` WHERE ${predicates.join(' AND ')}`, parameters };
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
