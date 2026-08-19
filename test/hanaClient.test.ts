import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Client } from 'hdb';

import { closeClient, connectClient, createClientOptions } from '../nodes/HanaSecure/hanaClient';
import type { HanaCredentials } from '../nodes/HanaSecure/types';

const credentials: HanaCredentials = {
	host: 'hana.example.com',
	port: 30015,
	databaseName: '',
	user: 'N8N_LAB_RO',
	password: 'not-a-real-secret',
	useTLS: true,
	rejectUnauthorized: true,
	allowedSchemas: 'N8N_LAB',
	allowAdvancedSql: false,
	connectionTimeout: 50,
	queryTimeout: 100,
};

describe('HANA client connection options', () => {
	it('ignores server topology by default for NAT and forwarded endpoints', () => {
		const options = createClientOptions(credentials);
		assert.equal(options.ignoreTopology, true);
		assert.equal(options.disableCloudRedirect, true);
		assert.equal(options['SESSIONVARIABLE:APPLICATION'], 'n8n-hana-secure');
		assert.equal(options.databaseName, undefined);
	});

	it('allows directly reachable scale-out deployments to use server topology', () => {
		const options = createClientOptions({ ...credentials, ignoreTopology: false });
		assert.equal(options.ignoreTopology, false);
		assert.equal(options.disableCloudRedirect, false);
	});
});

describe('HANA connection timeout', () => {
	it('destroys a client that never completes its connection handshake', async () => {
		let destroyed = false;
		const client = {
			connect() {},
			destroy() {
				destroyed = true;
			},
		} as unknown as Client;

		await assert.rejects(() => connectClient(client, 20), /Connection exceeded the 20 ms timeout/);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(destroyed, true);
	});
});

describe('HANA connection cleanup', () => {
	it('does not wait for a callback that hdb end() never invokes', () => {
		let closed = false;
		const client = {
			end() {
				closed = true;
			},
		} as unknown as Client;

		closeClient(client);
		assert.equal(closed, true);
	});
});
