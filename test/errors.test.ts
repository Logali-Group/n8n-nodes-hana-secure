import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hanaErrorOutput, toSafeHanaError } from '../nodes/HanaSecure/errors';
import type { HanaCredentials } from '../nodes/HanaSecure/types';

const credentials = {
	host: 'hana.internal.example',
	port: 30015,
	user: 'TRAINING_USER',
	password: 'top-secret',
} as HanaCredentials;

describe('safe HANA errors', () => {
	it('classifies retryable connection failures and redacts connection details', () => {
		const safe = toSafeHanaError(
			new Error('socket to hana.internal.example closed for TRAINING_USER / top-secret'),
			credentials,
		);
		assert.equal(safe.category, 'CONNECTION');
		assert.equal(safe.retryable, true);
		assert.doesNotMatch(safe.message, /TRAINING_USER|top-secret|hana\.internal/);
	});

	it('classifies permission failures as non-retryable and preserves safe codes', () => {
		const safe = toSafeHanaError(
			{ message: 'insufficient privilege', code: 258, sqlState: 'HY000' },
			credentials,
		);
		assert.deepEqual(hanaErrorOutput(safe), {
			error: 'SAP HANA request failed [PERMISSION]: insufficient privilege',
			errorCategory: 'PERMISSION',
			retryable: false,
			hanaCode: '258',
			sqlState: 'HY000',
		});
	});
});
