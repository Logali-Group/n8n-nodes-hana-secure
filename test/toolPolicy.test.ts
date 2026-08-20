import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	DEFAULT_AI_TOOL_MAX_ROWS,
	DEFAULT_AI_TOOL_MAX_BYTES,
	enforceAiToolByteLimit,
	isHanaSecureAiToolNode,
	resolveAiToolPolicy,
} from '../nodes/HanaSecure/toolPolicy';
import type { HanaCredentials } from '../nodes/HanaSecure/types';

const credentials: HanaCredentials = {
	host: 'hana.example.com',
	port: 30015,
	user: 'N8N_READ_ONLY',
	password: 'not-a-real-secret',
	useTLS: true,
	rejectUnauthorized: true,
	allowedSchemas: 'REPORTING',
	allowAdvancedSql: false,
	allowAiTool: true,
	aiToolMaxRows: 25,
	connectionTimeout: 15000,
	queryTimeout: 30000,
};

describe('AI tool policy', () => {
	it('detects the generated n8n AI Tool node type', () => {
		assert.equal(isHanaSecureAiToolNode('n8n-nodes-hana-secure.hanaSecureTool'), true);
		assert.equal(isHanaSecureAiToolNode('n8n-nodes-hana-secure.hanaSecure'), false);
		assert.equal(isHanaSecureAiToolNode('unsafeHanaSecureTool'), false);
	});

	it('keeps normal workflow executions unchanged in node v1.1', () => {
		assert.deepEqual(
			resolveAiToolPolicy('n8n-nodes-hana-secure.hanaSecure', 1.1, 'sql', 'executeSelect', {
				...credentials,
				allowAiTool: false,
			}),
			{ isTool: false },
		);
	});

	it('requires an explicit credential opt-in', () => {
		assert.throws(
			() =>
				resolveAiToolPolicy('n8n-nodes-hana-secure.hanaSecureTool', 1.1, 'rows', 'select', {
					...credentials,
					allowAiTool: false,
				}),
			/AI Tool use is disabled/,
		);
	});

	it('allows governed resources and applies the credential row cap', () => {
		assert.deepEqual(
			resolveAiToolPolicy(
				'n8n-nodes-hana-secure.hanaSecureTool',
				1.1,
				'rows',
				'select',
				credentials,
			),
			{ isTool: true, maxRows: 25, maxBytes: DEFAULT_AI_TOOL_MAX_BYTES },
		);
	});

	it('uses a conservative default cap for upgraded credentials', () => {
		const policy = resolveAiToolPolicy(
			'n8n-nodes-hana-secure.hanaSecureTool',
			1.1,
			'catalog',
			'listSchemas',
			{ ...credentials, aiToolMaxRows: undefined, allowAiCatalogDiscovery: true },
		);
		assert.equal(policy.maxRows, DEFAULT_AI_TOOL_MAX_ROWS);
	});

	it('blocks advanced SQL even when the credential permits it for normal workflows', () => {
		assert.throws(
			() =>
				resolveAiToolPolicy('n8n-nodes-hana-secure.hanaSecureTool', 1.1, 'sql', 'executeSelect', {
					...credentials,
					allowAdvancedSql: true,
				}),
			/Advanced SQL is never available/,
		);
	});

	it('requires a separate opt-in for AI catalog discovery in v1.1', () => {
		assert.throws(
			() =>
				resolveAiToolPolicy(
					'n8n-nodes-hana-secure.hanaSecureTool',
					1.1,
					'catalog',
					'listObjects',
					credentials,
				),
			/catalog discovery requires/i,
		);
	});

	it('preserves catalog compatibility for existing node v1 workflows', () => {
		assert.deepEqual(
			resolveAiToolPolicy(
				'n8n-nodes-hana-secure.hanaSecureTool',
				1,
				'catalog',
				'listObjects',
				credentials,
			),
			{ isTool: true, maxRows: 25 },
		);
	});

	it('rejects AI results above the byte cap', () => {
		assert.doesNotThrow(() => enforceAiToolByteLimit([{ OK: true }], 1024));
		assert.throws(
			() => enforceAiToolByteLimit([{ VALUE: 'x'.repeat(2000) }], 1024),
			/above the credential limit/,
		);
	});
});
