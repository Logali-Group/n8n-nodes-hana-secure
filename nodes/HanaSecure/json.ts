export function toJsonCompatible(value: unknown): unknown {
	if (value === null || value === undefined) return value ?? null;
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Date) return value.toISOString();
	if (Buffer.isBuffer(value)) return value.toString('base64');
	if (Array.isArray(value)) return value.map((entry) => toJsonCompatible(entry));
	if (typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, toJsonCompatible(entry)]),
		);
	}
	return value;
}

export function rowsToJson(rows: Record<string, unknown>[]): Record<string, unknown>[] {
	return rows.map((row) => toJsonCompatible(row) as Record<string, unknown>);
}
