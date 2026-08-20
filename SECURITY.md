# Security Policy

## Supported versions

Only the latest published minor version receives security fixes. Version `0.4.0` is a release
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
- optional schema and exact object allowlisting;
- object-scoped column policies across projections, predicates, sorting, grouping, and cursors;
- credential-required row filters that callers cannot remove;
- TLS and certificate validation defaults;
- connection and query timeouts;
- enforced row and catalog output limits;
- literal catalog-prefix filtering with wildcard escaping;
- credential redaction in driver error messages;
- advanced SQL disabled at credential level by default;
- separate credential opt-in for AI Tool use;
- separate AI Tool opt-in for catalog discovery;
- credential-level row and serialized-byte caps for every AI Tool call;
- advanced SQL blocked unconditionally in the AI Tool variant.

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
operations. In node v1.1+, advanced SQL also refuses any credential containing schema, object,
column, or required-filter policies. This is intentional: a conservative keyword guard cannot
prove that arbitrary nested SQL preserves every structured governance rule.

## MCP and AI tools

Version `0.4.0` is marked `usableAsTool`, so n8n can generate **Logali HANA Guard Tool**. The
generated variant refuses to run unless **Allow AI Tool Use** is enabled in the credential. It
supports Connection and structured Row operations, applies credential-level row and byte caps,
and rejects SQL (Advanced) unconditionally. Catalog discovery requires a second explicit switch.

Configure the Tool with fixed approved schemas, objects, columns, and limits. If a model must
supply a value, expose only a narrowly described filter value—not a schema, table, column list, or
SQL statement. For MCP, prefer fixed sub-workflows with the same approved projections and limits.
Protect MCP endpoints with authentication and retain the HANA user's least-privilege grants as the
final boundary.

## Write operations

This package does not implement writes. Do not add generic writes against SAP-owned S/4 tables.
Any future write capability must be a separate, explicitly reviewed design limited to
integration-owned staging objects or stored procedures, with a separate credential and threat
model. Business-document changes should use released SAP APIs or another supported transactional
interface.
