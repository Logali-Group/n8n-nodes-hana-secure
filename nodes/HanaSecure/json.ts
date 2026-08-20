export interface HanaJsonOptions {
	bigIntMode?: 'string' | 'number';
	binaryEncoding?: 'base64' | 'hex';
	dateMode?: 'iso' | 'epochMilliseconds';
}

export function toJsonCompatible(value: unknown, options: HanaJsonOptions = {}): unknown {
	if (value === null || value === undefined) return value ?? null;
	if (typeof value === 'bigint') {
		if (options.bigIntMode === 'number') {
			const number = Number(value);
			if (!Number.isSafeInteger(number)) {
				throw new Error(
					`HANA integer ${value.toString()} exceeds JavaScript's safe integer range. Use String for Big Integers.`,
				);
			}
			return number;
		}
		return value.toString();
	}
	if (value instanceof Date) {
		return options.dateMode === 'epochMilliseconds' ? value.getTime() : value.toISOString();
	}
	if (Buffer.isBuffer(value)) return value.toString(options.binaryEncoding ?? 'base64');
	if (Array.isArray(value)) return value.map((entry) => toJsonCompatible(entry, options));
	if (typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, toJsonCompatible(entry, options)]),
		);
	}
	return value;
}

export function rowsToJson(
	rows: Record<string, unknown>[],
	options: HanaJsonOptions = {},
): Record<string, unknown>[] {
	return rows.map((row) => toJsonCompatible(row, options) as Record<string, unknown>);
}

export function enforceJsonByteLimit(
	rows: Record<string, unknown>[],
	maxBytes: number,
	label = 'HANA result',
): number {
	if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 52_428_800) {
		throw new Error('Result size limit must be an integer between 1024 and 52428800 bytes.');
	}
	const byteLength = Buffer.byteLength(JSON.stringify(rows), 'utf8');
	if (byteLength > maxBytes) {
		throw new Error(
			`${label} is ${byteLength} bytes, above the configured limit of ${maxBytes} bytes. Reduce columns, filters, or rows.`,
		);
	}
	return byteLength;
}
