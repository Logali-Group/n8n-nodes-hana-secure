import type { Filter, FilterOperator, HanaCredentials } from './types';
import { assertIdentifier, parseAllowedSchemas } from './sqlSafety';

const MAX_POLICY_OBJECTS = 1000;
const MAX_POLICY_COLUMNS_PER_OBJECT = 1000;
const MAX_REQUIRED_FILTERS_PER_OBJECT = 100;

const POLICY_FILTER_OPERATORS = new Set<FilterOperator>([
	'eq',
	'ne',
	'gt',
	'ge',
	'lt',
	'le',
	'like',
	'notLike',
	'contains',
	'startsWith',
	'endsWith',
	'in',
	'notIn',
	'between',
	'isNull',
	'isNotNull',
]);

function objectKey(schema: string, objectName: string): string {
	return `${schema.toUpperCase()}.${objectName.toUpperCase()}`;
}

function parseObjectReference(value: string, label: string): string {
	const parts = value.trim().split('.');
	if (parts.length !== 2) {
		throw new Error(`${label} must use the SCHEMA.OBJECT format.`);
	}
	const schema = assertIdentifier(parts[0], `${label} schema`);
	const objectName = assertIdentifier(parts[1], `${label} object`);
	return objectKey(schema, objectName);
}

function parsePolicyObject(value: string | undefined, label: string): Record<string, unknown> {
	if (!value?.trim()) return {};
	let parsed: unknown;
	let parseFailed = false;
	try {
		parsed = JSON.parse(value);
	} catch {
		parseFailed = true;
	}
	if (parseFailed) throw new Error(`${label} must be valid JSON.`);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`${label} must be a JSON object keyed by SCHEMA.OBJECT.`);
	}
	return parsed as Record<string, unknown>;
}

export function parseAllowedObjects(value?: string): Set<string> {
	if (!value?.trim()) return new Set();
	const references = value
		.split(/[\n,]+/)
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => parseObjectReference(entry, 'Allowed object'));
	const uniqueReferences = new Set(references);
	if (uniqueReferences.size > MAX_POLICY_OBJECTS) {
		throw new Error(`Allowed Objects may contain at most ${MAX_POLICY_OBJECTS} entries.`);
	}
	return uniqueReferences;
}

export function assertObjectAllowed(
	schema: string,
	objectName: string,
	allowedObjects: Set<string>,
): void {
	if (allowedObjects.size === 0) return;
	if (!allowedObjects.has(objectKey(schema, objectName))) {
		throw new Error(`Object "${schema}.${objectName}" is not allowed by these credentials.`);
	}
}

export function isObjectAllowed(
	schema: string,
	objectName: string,
	allowedObjects: Set<string>,
): boolean {
	return allowedObjects.size === 0 || allowedObjects.has(objectKey(schema, objectName));
}

export function allowedObjectNamesForSchema(
	schema: string,
	allowedObjects: Set<string>,
): string[] | undefined {
	if (allowedObjects.size === 0) return undefined;
	const prefix = `${schema.toUpperCase()}.`;
	return [...allowedObjects]
		.filter((reference) => reference.startsWith(prefix))
		.map((reference) => reference.slice(prefix.length));
}

export function parseColumnPolicies(value?: string): Map<string, string[]> {
	const parsed = parsePolicyObject(value, 'Column Policies JSON');
	const policies = new Map<string, string[]>();
	for (const [reference, rawColumns] of Object.entries(parsed)) {
		const key = parseObjectReference(reference, 'Column policy key');
		if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
			throw new Error(`Column policy "${reference}" must contain a non-empty array.`);
		}
		if (rawColumns.length > MAX_POLICY_COLUMNS_PER_OBJECT) {
			throw new Error(
				`Column policy "${reference}" may contain at most ${MAX_POLICY_COLUMNS_PER_OBJECT} columns.`,
			);
		}
		const columns = rawColumns.map((column) => {
			if (typeof column !== 'string') {
				throw new Error(`Column policy "${reference}" may contain only column names.`);
			}
			return assertIdentifier(column, 'allowed column');
		});
		policies.set(key, [...new Set(columns)]);
	}
	return policies;
}

export function allowedColumnsForObject(
	schema: string,
	objectName: string,
	policies: Map<string, string[]>,
): string[] | undefined {
	return policies.get(objectKey(schema, objectName));
}

export function assertColumnsAllowed(columns: string[], allowedColumns?: string[]): void {
	if (!allowedColumns) return;
	const allowed = new Set(allowedColumns.map((column) => column.toUpperCase()));
	const denied = columns.filter((column) => !allowed.has(column.toUpperCase()));
	if (denied.length > 0) {
		throw new Error(`Column(s) not allowed by these credentials: ${denied.join(', ')}.`);
	}
}

function isPrimitive(value: unknown): boolean {
	return (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	);
}

function validatePolicyFilter(value: unknown, reference: string): Filter {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Required filter for "${reference}" must be an object.`);
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.column !== 'string') {
		throw new Error(`Required filter for "${reference}" needs a column.`);
	}
	const column = assertIdentifier(candidate.column, 'required filter column');
	const operator = candidate.operator;
	if (typeof operator !== 'string' || !POLICY_FILTER_OPERATORS.has(operator as FilterOperator)) {
		throw new Error(`Required filter for "${reference}" has an unsupported operator.`);
	}
	if (operator === 'isNull' || operator === 'isNotNull') {
		return { column, operator: operator as FilterOperator };
	}
	if (operator === 'in' || operator === 'notIn' || operator === 'between') {
		if (!Array.isArray(candidate.value) || !candidate.value.every(isPrimitive)) {
			throw new Error(
				`Required filter ${operator} for "${reference}" needs a primitive array value.`,
			);
		}
		return { column, operator: operator as FilterOperator, value: candidate.value };
	}
	if (!isPrimitive(candidate.value)) {
		throw new Error(`Required filter for "${reference}" needs a primitive value.`);
	}
	return { column, operator: operator as FilterOperator, value: candidate.value };
}

export function parseRequiredFilterPolicies(value?: string): Map<string, Filter[]> {
	const parsed = parsePolicyObject(value, 'Required Filters JSON');
	const policies = new Map<string, Filter[]>();
	for (const [reference, rawFilters] of Object.entries(parsed)) {
		const key = parseObjectReference(reference, 'Required filter key');
		if (!Array.isArray(rawFilters) || rawFilters.length === 0) {
			throw new Error(`Required filter policy "${reference}" must contain a non-empty array.`);
		}
		if (rawFilters.length > MAX_REQUIRED_FILTERS_PER_OBJECT) {
			throw new Error(
				`Required filter policy "${reference}" may contain at most ${MAX_REQUIRED_FILTERS_PER_OBJECT} filters.`,
			);
		}
		policies.set(
			key,
			rawFilters.map((filter) => validatePolicyFilter(filter, reference)),
		);
	}
	return policies;
}

export function requiredFiltersForObject(
	schema: string,
	objectName: string,
	policies: Map<string, Filter[]>,
): Filter[] {
	return policies.get(objectKey(schema, objectName)) ?? [];
}

export function hasStructuredGovernance(credentials: HanaCredentials): boolean {
	return Boolean(
		credentials.allowedSchemas?.trim() ||
			credentials.allowedObjects?.trim() ||
			credentials.columnPoliciesJson?.trim() ||
			credentials.requiredFiltersJson?.trim(),
	);
}

export function validateGovernanceConfiguration(credentials: HanaCredentials): void {
	const allowedSchemas = parseAllowedSchemas(credentials.allowedSchemas);
	const allowedObjects = parseAllowedObjects(credentials.allowedObjects);
	const columnPolicies = parseColumnPolicies(credentials.columnPoliciesJson);
	const requiredFilterPolicies = parseRequiredFilterPolicies(credentials.requiredFiltersJson);
	const governedReferences = new Set([...columnPolicies.keys(), ...requiredFilterPolicies.keys()]);

	for (const reference of allowedObjects) {
		const [schema] = reference.split('.');
		if (allowedSchemas.length > 0 && !allowedSchemas.includes(schema)) {
			throw new Error(`Allowed object "${reference}" is outside Allowed Schemas.`);
		}
	}

	for (const reference of governedReferences) {
		const [schema] = reference.split('.');
		if (allowedSchemas.length > 0 && !allowedSchemas.includes(schema)) {
			throw new Error(`Governance policy "${reference}" is outside Allowed Schemas.`);
		}
		if (allowedObjects.size > 0 && !allowedObjects.has(reference)) {
			throw new Error(`Governance policy "${reference}" is outside Allowed Objects.`);
		}

		const columns = columnPolicies.get(reference);
		const requiredFilters = requiredFilterPolicies.get(reference);
		if (columns && requiredFilters) {
			assertColumnsAllowed(
				requiredFilters.map((filter) => filter.column),
				columns,
			);
		}
	}
}
