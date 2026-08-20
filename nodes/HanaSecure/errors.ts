import type { HanaCredentials } from './types';

export type HanaErrorCategory =
	| 'CONNECTION'
	| 'NOT_FOUND'
	| 'PERMISSION'
	| 'QUERY'
	| 'TIMEOUT'
	| 'UNKNOWN';

export class SafeHanaError extends Error {
	constructor(
		message: string,
		public readonly category: HanaErrorCategory,
		public readonly retryable: boolean,
		public readonly hanaCode?: string,
		public readonly sqlState?: string,
	) {
		super(message);
		this.name = 'SafeHanaError';
	}
}

function redact(message: string, credentials: HanaCredentials): string {
	const secrets = [credentials.password, credentials.user, credentials.host].filter(Boolean);
	return secrets.reduce(
		(redacted, secret) => redacted.split(String(secret)).join('[REDACTED]'),
		message,
	);
}

export function toSafeHanaError(error: unknown, credentials: HanaCredentials): SafeHanaError {
	const candidate = error as { code?: unknown; sqlState?: unknown; message?: unknown };
	const original = error instanceof Error ? error.message : String(candidate?.message ?? error);
	const message = redact(original, credentials);
	const code = candidate?.code === undefined ? undefined : String(candidate.code);
	const sqlState = candidate?.sqlState === undefined ? undefined : String(candidate.sqlState);
	const normalized = `${code ?? ''} ${sqlState ?? ''} ${message}`.toLowerCase();

	let category: HanaErrorCategory = 'UNKNOWN';
	let retryable = false;
	if (/timeout|timed out|exceeded/.test(normalized)) {
		category = 'TIMEOUT';
		retryable = true;
	} else if (/econn|socket|connection|network|host unreachable|closed/.test(normalized)) {
		category = 'CONNECTION';
		retryable = true;
	} else if (/insufficient privilege|not authorized|permission|authorization/.test(normalized)) {
		category = 'PERMISSION';
	} else if (/invalid table|invalid view|object.*not found|unknown table/.test(normalized)) {
		category = 'NOT_FOUND';
	} else if (/sql|syntax|column|statement|parameter/.test(normalized)) {
		category = 'QUERY';
	}

	return new SafeHanaError(
		`SAP HANA request failed [${category}]: ${message}`,
		category,
		retryable,
		code,
		sqlState,
	);
}

export function hanaErrorOutput(error: unknown): Record<string, unknown> {
	if (!(error instanceof SafeHanaError)) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	return {
		error: error.message,
		errorCategory: error.category,
		retryable: error.retryable,
		...(error.hanaCode ? { hanaCode: error.hanaCode } : {}),
		...(error.sqlState ? { sqlState: error.sqlState } : {}),
	};
}
