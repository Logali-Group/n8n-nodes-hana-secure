import { createClient, type Client, type ClientOptions, type Statement } from 'hdb';

import type { HanaCredentials } from './types';

export interface HanaSession {
	query(sql: string, parameters?: unknown[]): Promise<Record<string, unknown>[]>;
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

function redactError(error: unknown, credentials: HanaCredentials): Error {
	const original = error instanceof Error ? error.message : String(error);
	const secrets = [credentials.password, credentials.user].filter(Boolean);
	const redacted = secrets.reduce(
		(message, secret) => message.split(secret).join('[REDACTED]'),
		original,
	);
	return new Error(`SAP HANA request failed: ${redacted}`);
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
		const session: HanaSession = {
			async query(sql, parameters = []) {
				if (parameters.length === 0) return await timeout(executeDirect(client, sql));
				const statement = await timeout(prepare(client, sql));
				try {
					return await timeout(executePrepared(statement, parameters));
				} finally {
					await dropStatement(statement);
				}
			},
		};
		return await callback(session);
	} catch (error) {
		throw redactError(error, credentials);
	} finally {
		if (connected && !timedOut) closeClient(client);
	}
}
