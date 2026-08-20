import type { IDataObject, INodeExecutionData } from 'n8n-workflow';

export type HanaOutputMode = 'eachRow' | 'singleItem' | 'addToInput';

function assertResultField(value: string): string {
	const field = value.trim();
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
		throw new Error(
			'Result Field must start with a letter or underscore and contain only letters, numbers, or underscores.',
		);
	}
	if (field === '__proto__' || field === 'constructor' || field === 'prototype') {
		throw new Error(`Result Field "${field}" is reserved.`);
	}
	return field;
}

export function formatHanaOutput(
	inputItem: INodeExecutionData,
	rows: Record<string, unknown>[],
	itemIndex: number,
	mode: HanaOutputMode,
	resultFieldValue: string,
): INodeExecutionData[] {
	if (mode === 'eachRow') {
		return rows.map((json) => ({
			json: json as IDataObject,
			pairedItem: { item: itemIndex },
		}));
	}

	const resultField = assertResultField(resultFieldValue);
	if (mode === 'singleItem') {
		return [
			{
				json: {
					[resultField]: rows,
					rowCount: rows.length,
				},
				pairedItem: { item: itemIndex },
			},
		];
	}

	return [
		{
			json: {
				...inputItem.json,
				[resultField]: rows,
			},
			...(inputItem.binary ? { binary: inputItem.binary } : {}),
			pairedItem: { item: itemIndex },
		},
	];
}
