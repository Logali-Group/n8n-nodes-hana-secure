import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class HanaSecureApi implements ICredentialType {
	name = 'hanaSecureApi';

	displayName = 'Logali HANA Guard API';

	icon = 'file:logaliHanaGuardCredential-v023.svg' as const;

	documentationUrl =
		'https://github.com/logali/n8n-nodes-hana-secure#credential-configuration';

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
			description: 'SAP HANA SQL port, not the HTTPS or OData port',
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
			displayName: 'Allow Advanced Read-Only SQL',
			name: 'allowAdvancedSql',
			type: 'boolean',
			default: false,
			description:
				'Whether workflows using these credentials may execute manually written SELECT statements',
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
