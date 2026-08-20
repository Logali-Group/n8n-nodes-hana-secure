import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class HanaSecureApi implements ICredentialType {
	name = 'hanaSecureApi';

	displayName = 'Logali HANA Guard API';

	icon = 'file:logaliHanaGuardCredential-v023.svg' as const;

	documentationUrl =
		'https://github.com/Logali-Group/n8n-nodes-hana-secure#credential-configuration';

	properties: INodeProperties[] = [
		{
			displayName: 'Host',
			name: 'host',
			type: 'string',
			default: '',
			placeholder: 'hana.example.com',
			description: 'DNS name or IP address of the SAP HANA SQL endpoint',
			required: true,
		},
		{
			displayName: 'SQL Port',
			name: 'port',
			type: 'number',
			default: 30015,
			description:
				'SAP HANA SQL endpoint port. HANA Cloud SQL endpoints normally use TCP 443; this is still a database connection, not HTTPS or OData.',
			required: true,
		},
		{
			displayName: 'Database Name',
			name: 'databaseName',
			type: 'string',
			default: '',
			placeholder: 'HDB',
			description: 'Optional tenant database name',
		},
		{
			displayName: 'Ignore Server Topology',
			name: 'ignoreTopology',
			type: 'boolean',
			default: true,
			description:
				'Keep enabled for NAT, port forwarding, proxies, and managed endpoints so the driver does not reconnect to internal HANA hosts',
		},
		{
			displayName: 'Username',
			name: 'user',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName: 'Use TLS',
			name: 'useTLS',
			type: 'boolean',
			default: true,
			description: 'Whether to encrypt the database connection with TLS',
		},
		{
			displayName: 'Validate TLS Certificate',
			name: 'rejectUnauthorized',
			type: 'boolean',
			default: true,
			description: 'Whether to reject certificates that cannot be validated',
			displayOptions: { show: { useTLS: [true] } },
		},
		{
			displayName: 'Custom CA Certificate',
			name: 'ca',
			type: 'string',
			typeOptions: { rows: 5 },
			default: '',
			placeholder: '-----BEGIN CERTIFICATE-----',
			description: 'Optional PEM-encoded CA certificate for a private certificate authority',
			displayOptions: { show: { useTLS: [true], rejectUnauthorized: [true] } },
		},
		{
			displayName: 'Allowed Schemas',
			name: 'allowedSchemas',
			type: 'string',
			default: '',
			placeholder: 'TRAINING,REPORTING',
			description:
				'Comma-separated schema allowlist. Leave empty to rely only on database permissions.',
		},
		{
			displayName: 'Allowed Objects',
			name: 'allowedObjects',
			type: 'string',
			typeOptions: { rows: 4 },
			default: '',
			placeholder: 'TRAINING.GL_ITEMS,\nREPORTING.OPEN_ORDERS',
			description:
				'Optional comma- or line-separated SCHEMA.OBJECT allowlist applied to catalog, describe, select, and aggregate operations',
		},
		{
			displayName: 'Column Policies JSON',
			name: 'columnPoliciesJson',
			type: 'string',
			typeOptions: { rows: 6 },
			default: '',
			placeholder: '{"TRAINING.GL_ITEMS":["COMPANY_CODE","AMOUNT","CURRENCY"]}',
			description:
				'Optional object-to-columns map. Selecting * expands only to approved columns; filters, sorting, grouping, and cursors are checked too.',
		},
		{
			displayName: 'Required Filters JSON',
			name: 'requiredFiltersJson',
			type: 'string',
			typeOptions: { rows: 7 },
			default: '',
			placeholder: '{"TRAINING.GL_ITEMS":[{"column":"MANDT","operator":"eq","value":"250"}]}',
			description:
				'Optional filters that credentials always add with AND to structured row reads, including AI Tool calls',
		},
		{
			displayName: 'Allow Advanced Read-Only SQL',
			name: 'allowAdvancedSql',
			type: 'boolean',
			default: false,
			description:
				'Whether trusted workflows may execute manually written SELECT statements. In node v1.1+, advanced SQL is blocked when any structured governance policy is configured.',
		},
		{
			displayName: 'Allow AI Tool Use',
			name: 'allowAiTool',
			type: 'boolean',
			default: false,
			description:
				'Whether this credential may be used by the Logali HANA Guard Tool variant. Advanced SQL remains blocked for tools.',
		},
		{
			displayName: 'Allow AI Catalog Discovery',
			name: 'allowAiCatalogDiscovery',
			type: 'boolean',
			default: false,
			description:
				'Whether the AI Tool may list schemas, list objects, and describe approved objects. Keep disabled when the agent already knows its target.',
			displayOptions: { show: { allowAiTool: [true] } },
		},
		{
			displayName: 'AI Tool Row Limit',
			name: 'aiToolMaxRows',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 1000 },
			default: 100,
			description:
				'Credential-level maximum number of rows returned by one AI tool call, even when the node requests a higher limit',
			displayOptions: { show: { allowAiTool: [true] } },
		},
		{
			displayName: 'AI Tool Result Size Limit (Bytes)',
			name: 'aiToolMaxBytes',
			type: 'number',
			typeOptions: { minValue: 1024, maxValue: 5242880 },
			default: 262144,
			description:
				'Maximum serialized result size for one AI Tool call; oversized results fail instead of flooding the agent context',
			displayOptions: { show: { allowAiTool: [true] } },
		},
		{
			displayName: 'Connection Timeout (ms)',
			name: 'connectionTimeout',
			type: 'number',
			typeOptions: { minValue: 1000, maxValue: 120000 },
			default: 15000,
			description: 'Maximum time allowed to establish a database connection',
		},
		{
			displayName: 'Query Timeout (ms)',
			name: 'queryTimeout',
			type: 'number',
			typeOptions: { minValue: 1000, maxValue: 300000 },
			default: 30000,
			description: 'Maximum execution time allowed for one database query',
		},
	];
}
