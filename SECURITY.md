# Security Policy

## Supported versions

Only the latest published minor version receives security fixes. Version `0.2.0` is a release
candidate and must be tested in a non-production, self-hosted n8n instance until publication.

## Reporting a vulnerability

Do not publish credentials, connection strings, customer data, or exploit details in a public
issue. After the repository is public, use a GitHub private security advisory. Before publication,
send a concise report to `admin@logaligroup.com`.

Include:

- affected version;
- operation and configuration involved;
- minimum reproduction without real credentials or business data;
- expected and observed behavior;
- potential impact.

## Security model

Logali HANA Guard is designed for read-only automation. Its application controls include:

- prepared statements for filter and advanced-SQL values;
- strict identifier validation;
- optional schema allowlisting;
- TLS and certificate validation defaults;
- connection and query timeouts;
- enforced row and catalog output limits;
- literal catalog-prefix filtering with wildcard escaping;
- credential redaction in driver error messages;
- advanced SQL disabled at credential level by default;
- no AI-tool exposure in version 1.

The controls do not turn an over-privileged database account into a safe account. The HANA user
must independently lack write, DDL, procedure-execution, user-management, and administrative
privileges.

## Deployment recommendations

- Run n8n in a private network or through a controlled tunnel when possible.
- Restrict the HANA firewall to the n8n egress address.
- Use a dedicated account per environment and rotate its secret.
- Limit access to n8n credentials and to workflows using this node.
- Prefer a curated reporting schema or calculation views over unrestricted business tables.
- Treat catalog visibility and object read permission as different controls. A user that can see
  `SAPHANADB.T001` in system metadata may still—and usually should—receive `insufficient
  privilege` when selecting its rows.
- Keep TLS certificate validation enabled. If a private CA is used, provide only the CA
  certificate, never a private key.
- Do not expose a HANA SQL port publicly merely to simplify a training exercise.

## Advanced SQL limitations

The advanced SQL parser is intentionally conservative and accepts only one statement beginning
with `SELECT`. It rejects comments, semicolons, caller limits, and sensitive keyword families.
This reduces accidental or obvious misuse; it is not a complete SQL firewall and does not analyze
all semantic behavior of a query.

For untrusted workflow authors, leave advanced SQL disabled and use only the structured
operations.

## MCP and AI tools

The node is intentionally not marked `usableAsTool`. If an MCP server or AI agent needs HANA data,
expose fixed sub-workflows with approved objects, columns, filters, and limits. Never expose a
generic SQL field as an MCP tool. Protect the MCP endpoint with authentication and retain the
database user's least-privilege grants as the final boundary.

## Write operations

This package does not implement writes. Do not add generic writes against SAP-owned S/4 tables.
Any future write capability must be a separate, explicitly reviewed design limited to
integration-owned staging objects or stored procedures, with a separate credential and threat
model. Business-document changes should use released SAP APIs or another supported transactional
interface.
