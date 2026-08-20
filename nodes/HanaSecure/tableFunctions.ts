import { OperationalError } from 'n8n-workflow';

import { parseTypedValue, quoteIdentifier } from './sqlSafety';
import type { FilterValueType } from './types';

export interface TableFunctionInput {
	name: string;
	value: unknown;
	valueType?: FilterValueType;
}

export interface TableFunctionParameterMetadata {
	name: string;
	dataTypeName: string;
	position: number;
	parameterType: string;
}

export interface TableFunctionSource {
	sql: string;
	parameters: unknown[];
}

const MAX_TABLE_FUNCTION_PARAMETERS = 20;

function normalizedName(value: string): string {
	return value.trim().toUpperCase();
}

export function isSupportedScalarFunctionParameter(dataTypeName: string): boolean {
	return !/(?:^|\s)(?:TABLE|ARRAY)(?:\s|$)/i.test(dataTypeName.trim());
}

/**
 * Builds a prepared HANA table-function source. Function and schema identifiers are
 * validated by quoteIdentifier; only catalog-declared scalar inputs are accepted and
 * values are ordered by catalog position before being bound to placeholders.
 */
export function buildTableFunctionSource(
	schema: string,
	functionName: string,
	inputs: TableFunctionInput[],
	metadata: TableFunctionParameterMetadata[],
): TableFunctionSource {
	if (metadata.length > MAX_TABLE_FUNCTION_PARAMETERS) {
		throw new OperationalError(
			`Table functions support at most ${MAX_TABLE_FUNCTION_PARAMETERS} scalar input parameters.`,
		);
	}

	const orderedMetadata = [...metadata]
		.filter((parameter) => ['IN', 'INOUT'].includes(parameter.parameterType.toUpperCase()))
		.sort((left, right) => left.position - right.position);
	for (const parameter of orderedMetadata) {
		if (!isSupportedScalarFunctionParameter(parameter.dataTypeName)) {
			throw new OperationalError(
				`Table-function parameter ${parameter.name} uses unsupported type ${parameter.dataTypeName}. Only scalar inputs are supported.`,
			);
		}

		if (!parameter.name.trim()) {
			throw new OperationalError('Every table-function input must have a catalog parameter name.');
		}
	}

	const supplied = new Map<string, TableFunctionInput>();
	for (const input of inputs) {
		const name = normalizedName(input.name);
		if (!name) throw new OperationalError('Every table-function input needs a parameter name.');
		if (supplied.has(name)) {
			throw new OperationalError(`Table-function input ${input.name} is configured more than once.`);
		}
		supplied.set(name, input);
	}

	const knownNames = new Set(orderedMetadata.map((parameter) => normalizedName(parameter.name)));
	const unknown = [...supplied.keys()].filter((name) => !knownNames.has(name));
	if (unknown.length > 0) {
		throw new OperationalError(`Unknown table-function input parameter(s): ${unknown.join(', ')}.`);
	}
	const missing = orderedMetadata
		.filter((parameter) => !supplied.has(normalizedName(parameter.name)))
		.map((parameter) => parameter.name);
	if (missing.length > 0) {
		throw new OperationalError(`Missing table-function input parameter(s): ${missing.join(', ')}.`);
	}

	const parameters = orderedMetadata.map((parameter) => {
		const input = supplied.get(normalizedName(parameter.name))!;
		if (input.valueType === 'null') return null;
		return parseTypedValue(input.value, input.valueType ?? 'string');
	});
	const placeholders = orderedMetadata.map(() => '?').join(', ');
	return {
		sql: `${quoteIdentifier(schema)}.${quoteIdentifier(functionName)}(${placeholders})`,
		parameters,
	};
}
