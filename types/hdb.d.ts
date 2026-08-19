declare module 'hdb' {
	export interface ClientOptions {
		host: string;
		port: number;
		user: string;
		password: string;
	databaseName?: string;
	disableCloudRedirect?: boolean;
	ignoreTopology?: boolean;
	useTLS?: boolean;
		rejectUnauthorized?: boolean;
		ca?: string[];
		servername?: string;
		initializationTimeout?: number;
		fetchSize?: number;
		'SESSIONVARIABLE:APPLICATION'?: string;
	}

	export interface Statement {
		exec(
			parameters: unknown[],
			callback: (error: Error | null, rows?: Record<string, unknown>[]) => void,
		): void;
		drop?(callback?: (error?: Error | null) => void): void;
	}

	export interface Client {
		connect(callback: (error?: Error | null) => void): void;
		exec(
			sql: string,
			callback: (error: Error | null, rows?: Record<string, unknown>[]) => void,
		): void;
		prepare(sql: string, callback: (error: Error | null, statement?: Statement) => void): void;
		end(): void;
		destroy(): void;
	}

	export function createClient(options: ClientOptions): Client;
}
