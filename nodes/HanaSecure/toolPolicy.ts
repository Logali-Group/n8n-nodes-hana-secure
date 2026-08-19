import { OperationalError } from 'n8n-workflow';

import type { HanaCredentials } from './types';

export const DEFAULT_AI_TOOL_MAX_ROWS = 100;
export const ABSOLUTE_AI_TOOL_MAX_ROWS = 1000;

const AI_TOOL_NODE_TYPE = /(?:^|\.)hanaSecureTool$/;
const AI_TOOL_ALLOWED_RESOURCES = new Set(['connection', 'catalog', 'rows']);

export interface AiToolPolicy {
	isTool: boolean;
	maxRows?: number;
}

export function isHanaSecureAiToolNode(nodeType: string): boolean {
	return AI_TOOL_NODE_TYPE.test(nodeType);
}

export function resolveAiToolPolicy(
	nodeType: string,
	resource: string,
	credentials: HanaCredentials,
): AiToolPolicy {
	if (!isHanaSecureAiToolNode(nodeType)) return { isTool: false };

	if (credentials.allowAiTool !== true) {
		throw new OperationalError(
			'AI Tool use is disabled in the selected credential. Enable it only for a governed, read-only agent.',
		);
	}

	if (!AI_TOOL_ALLOWED_RESOURCES.has(resource)) {
		throw new OperationalError(
			'Advanced SQL is never available through the AI Tool variant. Use Connection, Catalog, or structured Row operations.',
		);
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

	return { isTool: true, maxRows: configuredLimit };
}
