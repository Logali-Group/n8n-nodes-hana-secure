import { parseTypedValue, assertIdentifier, quoteIdentifier } from './sqlSafety';
import type { FilterValueType } from './types';

export type SemanticParameterMode = 'none' | 'sqlPositional' | 'calculationPlaceholders';

export interface SemanticParameterInput {
	name?: string;
	value: unknown;
	valueType?: FilterValueType;
}

export interface SemanticSource {
	sql: string;
	parameters: unknown[];
}

const MAX_SEMANTIC_PARAMETERS = 20;

/**
 * Builds a prepared HANA row source for regular SQL views, parameterized SQL/virtual
 * views, and calculation views. Only the values become bind parameters. Placeholder
 * names are validated as identifiers before being placed inside HANA's $$...$$ form.
 */
export function buildSemanticSource(
	schema: string,
	objectName: string,
	mode: SemanticParameterMode,
	parameters: SemanticParameterInput[],
): SemanticSource {
	const baseSource = `${quoteIdentifier(schema)}.${quoteIdentifier(objectName)}`;
	if (mode === 'none') return { sql: baseSource, parameters: [] };
	if (parameters.length === 0) throw new Error('Add at least one semantic view parameter.');
	if (parameters.length > MAX_SEMANTIC_PARAMETERS) {
		throw new Error(
			`A semantic view supports at most ${MAX_SEMANTIC_PARAMETERS} input parameters.`,
		);
	}

	const values = parameters.map((parameter) =>
		parseTypedValue(parameter.value, parameter.valueType ?? 'string'),
	);
	if (mode === 'sqlPositional') {
		return {
			sql: `${baseSource}(${parameters.map(() => '?').join(', ')})`,
			parameters: values,
		};
	}

	if (mode !== 'calculationPlaceholders') {
		throw new Error('Unsupported semantic view parameter mode.');
	}
	const names = parameters.map((parameter) =>
		assertIdentifier(parameter.name ?? '', 'calculation view parameter'),
	);
	if (new Set(names.map((name) => name.toUpperCase())).size !== names.length) {
		throw new Error('Calculation view parameter names must be unique.');
	}
	return {
		sql: `${baseSource}(${names.map((name) => `PLACEHOLDER."$$${name}$$" => ?`).join(', ')})`,
		parameters: values,
	};
}
