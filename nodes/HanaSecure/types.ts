export type HanaConnectionProfile = 'hanaPlatform' | 'hanaCloudHdi';

export interface HanaCredentials {
	connectionProfile?: HanaConnectionProfile;
	host: string;
	port: number;
	databaseName?: string;
	defaultSchema?: string;
	sapClient?: string;
	ignoreTopology?: boolean;
	user: string;
	password: string;
	useTLS: boolean;
	rejectUnauthorized: boolean;
	ca?: string;
	allowedSchemas?: string;
	allowedObjects?: string;
	columnPoliciesJson?: string;
	requiredFiltersJson?: string;
	allowAdvancedSql: boolean;
	allowAiTool?: boolean;
	allowAiCatalogDiscovery?: boolean;
	aiToolMaxRows?: number;
	aiToolMaxBytes?: number;
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
	| 'notLike'
	| 'contains'
	| 'startsWith'
	| 'endsWith'
	| 'in'
	| 'notIn'
	| 'between'
	| 'isNull'
	| 'isNotNull';

export interface Filter {
	column: string;
	operator: FilterOperator;
	value?: unknown;
}

export type FilterLogic = 'AND' | 'OR';

export type FilterValueType = 'string' | 'number' | 'boolean' | 'null' | 'json';

export interface UiFilter extends Filter {
	valueType?: FilterValueType;
	valuesJson?: string;
}

export interface UiKeyField {
	column: string;
	value: unknown;
	valueType?: Exclude<FilterValueType, 'null' | 'json'>;
}

export interface OrderBy {
	column: string;
	direction: 'ASC' | 'DESC';
}
