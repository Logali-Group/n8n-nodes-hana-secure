export function readCursorValue(
	row: Record<string, unknown>,
	cursorColumn: string,
): unknown {
	const entry = Object.entries(row).find(
		([column]) => column.toUpperCase() === cursorColumn.toUpperCase(),
	);
	if (!entry) {
		throw new Error(`Cursor column "${cursorColumn}" is missing from the HANA result.`);
	}
	if (entry[1] === null || entry[1] === undefined) {
		throw new Error(`Cursor column "${cursorColumn}" returned an empty value.`);
	}
	return entry[1];
}
