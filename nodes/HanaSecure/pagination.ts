import { OperationalError } from 'n8n-workflow';

import { buildWhereClause, combineWhereClauses } from './sqlSafety';
import type { Filter, OrderBy } from './types';

const CURSOR_VERSION = 1;
const MAX_CURSOR_COLUMNS = 5;

interface SqlFragment {
	sql: string;
	parameters: unknown[];
}

interface TaggedCursorValue {
	__hanaCursorType: 'bigint' | 'date' | 'binary';
	value: string;
}

export interface KeysetCursor {
	version: number;
	columns: string[];
	values: unknown[];
	direction: 'ASC' | 'DESC';
}

export interface KeysetPageCollection {
	rows: Record<string, unknown>[];
	pagesFetched: number;
	hasMore: boolean;
	nextCursor?: string;
}

export function readCursorValue(row: Record<string, unknown>, cursorColumn: string): unknown {
	const entry = Object.entries(row).find(
		([column]) => column.toUpperCase() === cursorColumn.toUpperCase(),
	);
	if (!entry) {
		throw new OperationalError(`Cursor column "${cursorColumn}" is missing from the HANA result.`);
	}
	if (entry[1] === null || entry[1] === undefined) {
		throw new OperationalError(`Cursor column "${cursorColumn}" returned an empty value.`);
	}
	return entry[1];
}

export function assertCursorColumns(columns: string[]): string[] {
	if (columns.length === 0) throw new OperationalError('At least one cursor column is required.');
	if (columns.length > MAX_CURSOR_COLUMNS) {
		throw new OperationalError(`A keyset cursor supports at most ${MAX_CURSOR_COLUMNS} columns.`);
	}
	const normalized = columns.map((column) => column.toUpperCase());
	if (new Set(normalized).size !== normalized.length) {
		throw new OperationalError('Cursor columns must be unique.');
	}
	return columns;
}

function serializeCursorValue(value: unknown): unknown {
	if (typeof value === 'bigint') {
		return { __hanaCursorType: 'bigint', value: value.toString() } satisfies TaggedCursorValue;
	}
	if (value instanceof Date) {
		return { __hanaCursorType: 'date', value: value.toISOString() } satisfies TaggedCursorValue;
	}
	if (Buffer.isBuffer(value)) {
		return {
			__hanaCursorType: 'binary',
			value: value.toString('base64'),
		} satisfies TaggedCursorValue;
	}
	if (typeof value === 'number' && !Number.isFinite(value)) {
		throw new OperationalError('Cursor values cannot contain NaN or an infinite number.');
	}
	if (['string', 'number', 'boolean'].includes(typeof value)) return value;
	throw new OperationalError(
		'Cursor values must be strings, numbers, booleans, dates, integers, or binary values.',
	);
}

function deserializeCursorValue(value: unknown): unknown {
	if (['string', 'number', 'boolean'].includes(typeof value)) {
		if (typeof value === 'number' && !Number.isFinite(value)) {
			throw new OperationalError('Cursor token contains a non-finite number.');
		}
		return value;
	}
	if (!value || typeof value !== 'object') {
		throw new OperationalError('Cursor token contains an unsupported value.');
	}
	const tagged = value as Partial<TaggedCursorValue>;
	if (typeof tagged.value !== 'string') {
		throw new OperationalError('Cursor token contains an invalid tagged value.');
	}
	if (tagged.__hanaCursorType === 'bigint') {
		if (!/^-?\d+$/.test(tagged.value)) {
			throw new OperationalError('Cursor token contains an invalid integer.');
		}
		return BigInt(tagged.value);
	}
	if (tagged.__hanaCursorType === 'date') {
		const date = new Date(tagged.value);
		if (Number.isNaN(date.getTime())) {
			throw new OperationalError('Cursor token contains an invalid date.');
		}
		return date;
	}
	if (tagged.__hanaCursorType === 'binary') return Buffer.from(tagged.value, 'base64');
	throw new OperationalError('Cursor token contains an unsupported tagged value.');
}

export function encodeCursor(
	row: Record<string, unknown>,
	columns: string[],
	direction: 'ASC' | 'DESC',
): string {
	const safeColumns = assertCursorColumns(columns);
	const cursor: KeysetCursor = {
		version: CURSOR_VERSION,
		columns: safeColumns,
		values: safeColumns.map((column) => serializeCursorValue(readCursorValue(row, column))),
		direction,
	};
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(token: string): KeysetCursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(token.trim(), 'base64url').toString('utf8'));
	} catch {
		// Converted to NodeOperationError by the execute boundary, which has node context.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		throw new OperationalError('Cursor token is invalid or corrupted.');
	}
	if (!parsed || typeof parsed !== 'object') throw new OperationalError('Cursor token is invalid.');
	const cursor = parsed as Partial<KeysetCursor>;
	if (
		cursor.version !== CURSOR_VERSION ||
		!Array.isArray(cursor.columns) ||
		!cursor.columns.every((column) => typeof column === 'string') ||
		!Array.isArray(cursor.values) ||
		cursor.columns.length !== cursor.values.length ||
		(cursor.direction !== 'ASC' && cursor.direction !== 'DESC')
	) {
		throw new OperationalError('Cursor token has an unsupported shape or version.');
	}
	assertCursorColumns(cursor.columns);
	return {
		version: cursor.version,
		columns: cursor.columns,
		values: cursor.values.map((value) => deserializeCursorValue(value)),
		direction: cursor.direction,
	} as KeysetCursor;
}

export function buildCompositeKeysetWhere(cursor: KeysetCursor): SqlFragment {
	const operator = cursor.direction === 'DESC' ? 'lt' : 'gt';
	const alternatives = cursor.columns.map((column, index) => {
		const filters: Filter[] = [];
		for (let prefix = 0; prefix < index; prefix += 1) {
			filters.push({
				column: cursor.columns[prefix],
				operator: 'eq',
				value: cursor.values[prefix],
			});
		}
		filters.push({ column, operator, value: cursor.values[index] });
		return buildWhereClause(filters, 'AND');
	});
	if (alternatives.length === 1) return alternatives[0];
	return {
		sql: ` WHERE (${alternatives
			.map((fragment, index) => {
				const body = fragment.sql.replace(/^ WHERE /, '');
				return index === 0 ? body : `(${body})`;
			})
			.join(' OR ')})`,
		parameters: alternatives.flatMap((fragment) => fragment.parameters),
	};
}

export function cursorOrderBy(
	columns: string[],
	direction: 'ASC' | 'DESC',
	additional: OrderBy[],
): OrderBy[] {
	const safeColumns = assertCursorColumns(columns);
	const cursorNames = new Set(safeColumns.map((column) => column.toUpperCase()));
	return [
		...safeColumns.map((column) => ({ column, direction })),
		...additional.filter((sort) => !cursorNames.has(sort.column.toUpperCase())),
	];
}

export function combineCursorWhere(base: SqlFragment, cursor?: KeysetCursor): SqlFragment {
	return cursor ? combineWhereClauses(base, buildCompositeKeysetWhere(cursor)) : base;
}

export async function collectKeysetPages(
	columns: string[],
	direction: 'ASC' | 'DESC',
	pageSize: number,
	maximumRows: number,
	maximumPages: number,
	initialCursor: KeysetCursor | undefined,
	fetchPage: (
		cursor: KeysetCursor | undefined,
		limit: number,
	) => Promise<Record<string, unknown>[]>,
): Promise<KeysetPageCollection> {
	const safeColumns = assertCursorColumns(columns);
	const collectedRows: Record<string, unknown>[] = [];
	let cursor = initialCursor;
	let pagesFetched = 0;
	let hasMore = false;

	while (pagesFetched < maximumPages && collectedRows.length < maximumRows) {
		const currentLimit = Math.min(pageSize, maximumRows - collectedRows.length);
		const pageRows = await fetchPage(cursor, currentLimit);
		pagesFetched += 1;
		const limitedPage = pageRows.slice(0, currentLimit);
		collectedRows.push(...limitedPage);
		hasMore = pageRows.length > currentLimit;
		if (!hasMore || limitedPage.length === 0) break;
		cursor = decodeCursor(
			encodeCursor(limitedPage[limitedPage.length - 1], safeColumns, direction),
		);
	}

	return {
		rows: collectedRows,
		pagesFetched,
		hasMore,
		...(hasMore && collectedRows.length > 0
			? {
					nextCursor: encodeCursor(collectedRows[collectedRows.length - 1], safeColumns, direction),
				}
			: {}),
	};
}
