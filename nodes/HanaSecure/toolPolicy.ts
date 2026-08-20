import { OperationalError } from 'n8n-workflow';

import type { HanaCredentials } from './types';

export const DEFAULT_AI_TOOL_MAX_ROWS = 100;
export const ABSOLUTE_AI_TOOL_MAX_ROWS = 1000;
export const DEFAULT_AI_TOOL_MAX_BYTES = 262_144;
export const ABSOLUTE_AI_TOOL_MAX_BYTES = 5_242_880;

const AI_TOOL_NODE_TYPE = /(?:^|\.)hanaSecureTool$/;
const AI_TOOL_ALLOWED_OPERATIONS = new Set([
	'connection:testConnection',
	'connection:getDatabaseInfo',
	'rows:select',
	'rows:getByKey',
	'rows:aggregate',
	'rows:count',
	'rows:distinct',
	'rows:exists',
	'rows:preview',
]);

export interface AiToolPolicy {
	isTool: boolean;
	maxRows?: number;
	maxBytes?: number;
}

export function isHanaSecureAiToolNode(nodeType: string): boolean {
	return AI_TOOL_NODE_TYPE.test(nodeType);
}

export function resolveAiToolPolicy(
	nodeType: string,
	nodeVersion: number,
	resource: string,
	operation: string,
	credentials: HanaCredentials,
): AiToolPolicy {
	if (!isHanaSecureAiToolNode(nodeType)) return { isTool: false };

	if (credentials.allowAiTool !== true) {
		throw new OperationalError(
			'AI Tool use is disabled in the selected credential. Enable it only for a governed, read-only agent.',
		);
	}

	if (resource === 'sql') {
		throw new OperationalError(
			'Advanced SQL is never available through the AI Tool variant. Use Connection, Catalog, or structured Row operations.',
		);
	}

	if (nodeVersion >= 1.1) {
		const operationKey = `${resource}:${operation}`;
		const catalogAllowed = resource === 'catalog' && credentials.allowAiCatalogDiscovery === true;
		if (!AI_TOOL_ALLOWED_OPERATIONS.has(operationKey) && !catalogAllowed) {
			throw new OperationalError(
				'This operation is not enabled for AI Tool use. Catalog discovery requires its own credential opt-in.',
			);
		}
	}

	const configuredLimit = credentials.aiToolMaxRows ?? DEFAULT_AI_TOOL_MAX_ROWS;
	if (
		!Number.isInteger(configuredLimit) ||
		configuredLimit < 1 ||
		configuredLimit > ABSOLUTE_AI_TOOL_MAX_ROWS
	) {
		throw new OperationalError(
			`AI Tool row limit must be an integer between 1 and ${ABSOLUTE_AI_TOOL_MAX_ROWS}.`,
		);
	}

	if (nodeVersion < 1.1) return { isTool: true, maxRows: configuredLimit };

	const configuredBytes = credentials.aiToolMaxBytes ?? DEFAULT_AI_TOOL_MAX_BYTES;
	if (
		!Number.isInteger(configuredBytes) ||
		configuredBytes < 1024 ||
		configuredBytes > ABSOLUTE_AI_TOOL_MAX_BYTES
	) {
		throw new OperationalError(
			`AI Tool byte limit must be an integer between 1024 and ${ABSOLUTE_AI_TOOL_MAX_BYTES}.`,
		);
	}

	return { isTool: true, maxRows: configuredLimit, maxBytes: configuredBytes };
}

export function enforceAiToolByteLimit(rows: Record<string, unknown>[], maxBytes?: number): void {
	if (maxBytes === undefined) return;
	const byteLength = Buffer.byteLength(JSON.stringify(rows), 'utf8');
	if (byteLength > maxBytes) {
		throw new OperationalError(
			`AI Tool result is ${byteLength} bytes, above the credential limit of ${maxBytes} bytes. Reduce columns, filters, or rows.`,
		);
	}
}
