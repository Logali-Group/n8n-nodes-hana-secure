import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HanaSecure } from '../nodes/HanaSecure/HanaSecure.node';

describe('HANA Guard node description', () => {
	it('keeps the table or view selector visible for legacy and current row nodes', () => {
		const properties = new HanaSecure().description.properties.filter(
			(property) => property.name === 'objectName' && property.displayName === 'Table or View Name or ID',
		);

		const rowProperties = properties.filter((property) => {
			const show = property.displayOptions?.show as Record<string, unknown> | undefined;
			return Array.isArray(show?.resource) && show.resource.includes('rows');
		});

		assert.equal(rowProperties.length, 2);

		const legacyShow = rowProperties.find((property) => {
			const show = property.displayOptions?.show as Record<string, unknown> | undefined;
			return show?.sourceKind === undefined;
		})?.displayOptions?.show;
		const currentShow = rowProperties.find((property) => {
			const show = property.displayOptions?.show as Record<string, unknown> | undefined;
			return Array.isArray(show?.sourceKind) && show.sourceKind.includes('tableOrView');
		})?.displayOptions?.show;

		assert.deepEqual(legacyShow?.['@version'], [{ _cnd: { lte: 1.3 } }]);
		assert.deepEqual(currentShow?.['@version'], [{ _cnd: { gte: 1.4 } }]);
	});
});
