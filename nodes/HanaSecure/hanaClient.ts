import { createClient, type Client, type ClientOptions, type Statement } from 'hdb';

import { toSafeHanaError } from './errors';
import type { HanaCredentials } from './types';

export interface HanaSession {
	query(sql: string, parameters?: unknown[]): Promise<Record<string, unknown>[]>;
	diagnostics(): {
		queryCount: number;
		lastQueryFingerprint?: string;
	};
}

export function queryFingerprint(sql: string): string {
	const normalized = sql.replace(/\s+/g, ' ').trim();
	let hash = 0x811c9dc5;
	for (let index = 0; index < normalized.length; index += 1) {
		hash ^= normalized.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

export function connectClient(client: Client, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => {
			finish(new Error(`Connection exceeded the ${timeoutMs} ms timeout.`));
			setTimeout(() => client.destroy(), 0);
		}, timeoutMs);
		client.connect((error) => finish(error));
	});
}

function executeDirect(client: Client, sql: string): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		client.exec(sql, (error, rows = []) => (error ? reject(error) : resolve(rows)));
	});
}

function prepare(client: Client, sql: string): Promise<Statement> {
	return new Promise((resolve, reject) => {
		client.prepare(sql, (error, statement) => {
			if (error || !statement) reject(error ?? new Error('SAP HANA did not return a statement.'));
			else resolve(statement);
		});
	});
}

function executePrepared(
	statement: Statement,
	parameters: unknown[],
): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		statement.exec(parameters, (error, rows = []) => (error ? reject(error) : resolve(rows)));
	});
}

async function dropStatement(statement: Statement): Promise<void> {
	if (!statement.drop) return;
	await new Promise<void>((resolve) => {
		statement.drop?.(() => resolve());
	});
}

export function closeClient(client: Client): void {
	try {
		// hdb aliases end() to close(); it is synchronous and does not invoke a callback.
		client.end();
	} catch {
		// Closing an already-broken socket must not hide the query result or original error.
	}
}

export function createClientOptions(credentials: HanaCredentials): ClientOptions {
	const options: ClientOptions = {
		host: credentials.host,
		port: Number(credentials.port),
		user: credentials.user,
		password: credentials.password,
		useTLS: credentials.useTLS,
		rejectUnauthorized: credentials.rejectUnauthorized,
		servername: credentials.host,
		ignoreTopology: credentials.ignoreTopology !== false,
		disableCloudRedirect: credentials.ignoreTopology !== false,
		initializationTimeout: Number(credentials.connectionTimeout),
		fetchSize: 256,
		'SESSIONVARIABLE:APPLICATION': 'n8n-hana-secure',
	};
	if (credentials.databaseName?.trim()) options.databaseName = credentials.databaseName.trim();
	if (credentials.useTLS && credentials.ca?.trim()) options.ca = [credentials.ca.trim()];
	return options;
}

export async function withHanaClient<T>(
	credentials: HanaCredentials,
	callback: (session: HanaSession) => Promise<T>,
): Promise<T> {
	const client = createClient(createClientOptions(credentials));
	let connected = false;
	let timedOut = false;

	const timeout = <R>(promise: Promise<R>): Promise<R> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				timedOut = true;
				reject(new Error(`Query exceeded the ${credentials.queryTimeout} ms timeout.`));
				setTimeout(() => client.destroy(), 0);
			}, Number(credentials.queryTimeout));
			void promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});

	try {
		await connectClient(client, Number(credentials.connectionTimeout));
		connected = true;
		let queryCount = 0;
		let lastQueryFingerprint: string | undefined;
		const session: HanaSession = {
			async query(sql, parameters = []) {
				queryCount += 1;
				lastQueryFingerprint = queryFingerprint(sql);
				if (parameters.length === 0) return await timeout(executeDirect(client, sql));
				const statement = await timeout(prepare(client, sql));
				try {
					return await timeout(executePrepared(statement, parameters));
				} finally {
					await dropStatement(statement);
				}
			},
			diagnostics() {
				return { queryCount, ...(lastQueryFingerprint ? { lastQueryFingerprint } : {}) };
			},
		};
		return await callback(session);
	} catch (error) {
		throw toSafeHanaError(error, credentials);
	} finally {
		if (connected && !timedOut) closeClient(client);
	}
}
