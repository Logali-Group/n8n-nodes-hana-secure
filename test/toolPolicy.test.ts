import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	DEFAULT_AI_TOOL_MAX_ROWS,
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
		assert.equal(
			isHanaSecureAiToolNode('n8n-nodes-hana-secure.hanaSecureTool'),
			true,
		);
		assert.equal(isHanaSecureAiToolNode('n8n-nodes-hana-secure.hanaSecure'), false);
		assert.equal(isHanaSecureAiToolNode('unsafeHanaSecureTool'), false);
	});

	it('keeps normal workflow executions unchanged', () => {
		assert.deepEqual(
			resolveAiToolPolicy('n8n-nodes-hana-secure.hanaSecure', 'sql', {
				...credentials,
				allowAiTool: false,
			}),
			{ isTool: false },
		);
	});

	it('requires an explicit credential opt-in', () => {
		assert.throws(
			() =>
				resolveAiToolPolicy('n8n-nodes-hana-secure.hanaSecureTool', 'rows', {
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
				'rows',
				credentials,
			),
			{ isTool: true, maxRows: 25 },
		);
	});

	it('uses a conservative default cap for upgraded credentials', () => {
		const policy = resolveAiToolPolicy(
			'n8n-nodes-hana-secure.hanaSecureTool',
			'catalog',
			{ ...credentials, aiToolMaxRows: undefined },
		);
		assert.equal(policy.maxRows, DEFAULT_AI_TOOL_MAX_ROWS);
	});

	it('blocks advanced SQL even when the credential permits it for normal workflows', () => {
		assert.throws(
			() =>
				resolveAiToolPolicy('n8n-nodes-hana-secure.hanaSecureTool', 'sql', {
					...credentials,
					allowAdvancedSql: true,
				}),
			/Advanced SQL is never available/,
		);
	});
});
