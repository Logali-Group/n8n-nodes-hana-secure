export interface HanaCredentials {
	host: string;
	port: number;
	databaseName?: string;
	ignoreTopology?: boolean;
	user: string;
	password: string;
	useTLS: boolean;
	rejectUnauthorized: boolean;
	ca?: string;
	allowedSchemas?: string;
	allowAdvancedSql: boolean;
	allowAiTool?: boolean;
	aiToolMaxRows?: number;
	connectionTimeout: number;
	queryTimeout: number;
}

export type FilterOperator =
	| 'eq'
	| 'ne'
	| 'gt'
	| 'ge'
	| 'lt'
	| 'le'
	| 'like'
	| 'isNull'
	| 'isNotNull';

export interface Filter {
	column: string;
	operator: FilterOperator;
	value?: unknown;
}

export interface OrderBy {
	column: string;
	direction: 'ASC' | 'DESC';
}
