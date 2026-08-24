import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HanaSecureApi } from '../credentials/HanaSecureApi.credentials';

describe('HANA credential defaults', () => {
	it('allows a cold remote TLS endpoint up to 60 seconds to connect', () => {
		const credential = new HanaSecureApi();
		const connectionTimeout = credential.properties.find(
			(property) => property.name === 'connectionTimeout',
		);

		assert.ok(connectionTimeout);
		assert.equal(connectionTimeout.default, 60000);
		assert.deepEqual(connectionTimeout.typeOptions, { minValue: 1000, maxValue: 120000 });
	});
});
