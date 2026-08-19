# Logali HANA Guard for n8n

<img src="assets/logali-hana-guard-concept.png" alt="Logali HANA Guard concept mark" width="220">

`n8n-nodes-hana-secure` is a security-first n8n community node for governed reads from SAP HANA
Platform and SAP HANA Cloud. The package name stays descriptive and searchable; the node appears
in n8n as **Logali HANA Guard**.

> Status: release candidate `0.2.3`. Connection, catalog, metadata, and guarded structured reads
> have been tested against SAP HANA `2.00.088`. The package has not yet been published to npm.

## Why this node exists

Direct database access can be useful for reporting, reconciliation, data-quality checks, and
controlled integration scenarios. It also needs a stricter contract than a generic SQL text box.
Logali HANA Guard therefore makes structured read operations the default and places advanced SQL
behind an explicit credential-level switch.

This package:

- reads data only;
- binds filter values through prepared statements;
- validates and quotes schema, object, and column identifiers;
- supports a credential-level schema allowlist;
- enforces query timeouts and hard result limits, including catalog discovery;
- escapes catalog-name wildcards and supports a literal object-name prefix;
- enables TLS and certificate validation by default;
- keeps manually written SQL disabled by default;
- is intentionally unavailable as an n8n AI tool in this release.

These controls are defense in depth. A least-privilege HANA user remains the primary security
boundary.

## HANA SQL or OData?

| Requirement | Prefer direct HANA SQL | Prefer OData / released SAP API |
| --- | --- | --- |
| Reconciliation, diagnostics, private reporting | Yes, through an approved view or exact read grant | Also valid when the released API contains the fields |
| Read technical metadata or large analytical projections | Often | Sometimes |
| Preserve SAP business validations and authorizations | No | Yes |
| Create or change S/4 business documents | No | Yes |
| Write into an integration-owned staging or queue table | Possible with a separate write credential and reviewed procedure | Optional |

Never use generic `INSERT`, `UPDATE`, or `DELETE` against internal S/4 application tables. Basic
writes can be appropriate only for objects the integration owns, such as a staging table, queue,
or audited stored procedure. Business changes belong behind released OData APIs, BAPIs, CAP
services, or another SAP-supported transactional contract.

## Compatibility

- Self-hosted n8n only
- Node.js 22 or later
- SAP HANA Platform or SAP HANA Cloud with an accessible SQL endpoint
- TCP connectivity from the n8n host or container to the HANA SQL port

This is not an OData node. An HTTPS/OData port such as `443` or a reverse-proxy port cannot be used
as the HANA SQL port unless an administrator has explicitly configured a compatible TCP proxy.

The node uses the Apache-2.0-licensed `hdb` driver maintained by SAP contributors. The driver is
bundled into the published artifact, so users do not need to install a native HANA client.
Version `2.27.1` is pinned for this pre-release because the `2.29.x` topology/physical-connection
rewrite stalled authentication through the tested NAT endpoint. Compatibility with newer driver
versions will be re-evaluated before a stable release.

## Installation

### Local pre-release test

From this repository:

```bash
npm install
npm test
npm run lint
npm run build
```

Run `npm pack` to create an installable tarball. Install the tarball only in a non-production,
self-hosted n8n instance while the package is in pre-release.

### Install the pre-release tarball in Docker

The package isn't on the npm registry yet, so it can't be installed by name from the n8n
**Community Nodes** screen. Copy the tarball to the Docker host and replace `<n8n-container>` with
the development container name:

```bash
docker cp n8n-nodes-hana-secure-0.2.3.tgz <n8n-container>:/tmp/

docker exec -u node -it <n8n-container> sh
mkdir -p /home/node/.n8n/nodes
cd /home/node/.n8n/nodes
npm install --omit=dev /tmp/n8n-nodes-hana-secure-0.2.3.tgz
exit

docker restart <n8n-container>
```

The `/home/node/.n8n` directory must be backed by a persistent volume. After the restart, refresh
n8n and search for **Logali HANA Guard**. Verify the installed version from the Docker host:

```bash
docker exec -u node <n8n-container> sh -lc \
  'cd /home/node/.n8n/nodes && npm ls n8n-nodes-hana-secure'
```

If n8n runs in queue mode, install the package in the main container and every worker, or build a
custom n8n image containing the package. Keep these settings enabled:

```text
N8N_COMMUNITY_PACKAGES_ENABLED=true
N8N_UNVERIFIED_PACKAGES_ENABLED=true
N8N_COMMUNITY_PACKAGES_PREVENT_LOADING=false
```

To uninstall the pre-release:

```bash
docker exec -u node <n8n-container> sh -lc \
  'cd /home/node/.n8n/nodes && npm uninstall n8n-nodes-hana-secure'
docker restart <n8n-container>
```

### After npm publication

In a self-hosted n8n instance, open **Settings → Community Nodes**, choose **Install**, and enter:

```text
n8n-nodes-hana-secure
```

Community nodes are not supported on n8n Cloud when they require external runtime capabilities.

## Credential configuration

Create a **Logali HANA Guard API** credential with:

| Field | Purpose |
| --- | --- |
| Host | HANA SQL endpoint hostname or IP address |
| SQL Port | Tenant database SQL port |
| Database Name | Optional tenant database name; leave empty when the endpoint already targets the tenant SQL port |
| Ignore Server Topology | Keeps NAT, forwarded, proxy, and managed endpoints on the configured host; enabled by default |
| Username / Password | Dedicated technical user; never use a broad administrator |
| Use TLS | Encrypts the connection; enabled by default |
| Validate TLS Certificate | Rejects untrusted certificates; enabled by default |
| Custom CA Certificate | Optional PEM CA for a private certificate authority |
| Allowed Schemas | Optional comma-separated schema allowlist |
| Allow Advanced Read-Only SQL | Opt-in switch for trusted workflows; disabled by default |
| Connection / Query Timeout | Upper bounds for connection and query execution |

Use **Test** in the credential dialog, or the node's **Connection → Test Connection** operation.

For NAT or port-forwarded laboratory endpoints, leave **Database Name** empty when the published
port already targets the tenant and keep **Ignore Server Topology** enabled. Pre-release `0.1.6`
was verified on SAP HANA `2.00.088` with connection metadata, schema listing, and a structured
read from `SYS.M_DATABASE`. The same test account could see that the `SAPHANADB` schema and its
tables existed but received `insufficient privilege` when it attempted to read `SAPHANADB.T001`.
That is the intended lesson: catalog visibility and network reachability do not grant access to
S/4 business rows.

### Recommended database account

Ask the HANA administrator for a dedicated technical user or role with:

- connection permission;
- `SELECT` only on the specific calculation views, tables, or training schema required;
- no `INSERT`, `UPDATE`, `DELETE`, DDL, procedure execution, user administration, or system
  administration privileges.

Exact grants depend on the HANA model and organizational policy. Do not copy a production business
user or database administrator account into n8n.

## Operations

### Connection

- **Test Connection**: returns the active user, schema, database, and TLS state.

### Catalog

- **List Schemas**: lists visible non-system schemas and applies the credential allowlist.
- **List Tables and Views**: lists objects in one allowed schema, with an optional literal prefix
  and a result limit of 1–1,000 (100 by default).
- **Describe Table or View**: returns column metadata from the HANA system catalog.

### Row

- **Select Rows**: choose columns, filters, sorting, and a row limit without writing SQL.
- **Aggregate Rows**: use `COUNT`, `SUM`, `AVG`, `MIN`, or `MAX`, with optional grouping and
  filters.

### SQL (Advanced)

- **Execute Read-Only SQL**: executes one `SELECT` with positional `?` parameters.

The advanced operation rejects semicolons, comments, caller-provided `LIMIT`/`TOP`, and write,
administrative, procedure, and transaction keywords. The SQL field does not accept n8n
expressions. Parameter values are provided as a JSON array.

Example:

```sql
SELECT "COMPANY_CODE", "FISCAL_YEAR", "AMOUNT"
FROM "TRAINING"."GL_ITEMS"
WHERE "COMPANY_CODE" = ? AND "FISCAL_YEAR" = ?
```

```json
["1010", 2026]
```

The guard is not a substitute for database permissions. Enable advanced SQL only for trusted
workflow editors.

## Example workflows

[`examples/415_hana_secure_readonly.json`](examples/415_hana_secure_readonly.json) contains a
sanitized workflow with no credentials, hosts, user names, or internal identifiers. After import,
attach your own credential and replace the training schema and view names.

The webinar examples are also sanitized:

- [`examples/webinar_catalog_discovery.json`](examples/webinar_catalog_discovery.json) verifies
  the session and discovers visible schemas;
- [`examples/webinar_object_inventory.json`](examples/webinar_object_inventory.json) checks three
  pre-approved demo objects through `SYS.M_TABLES`, without reading business rows;
- [`examples/webinar_data_samples.json`](examples/webinar_data_samples.json) contains the bounded
  T001, VBAK, and ACDOCA reads to run only after the dedicated account receives reviewed grants.

[`sql/setup_webinar_readonly.sql`](sql/setup_webinar_readonly.sql) is a reviewable lab template
for the exact role and object grants. It contains placeholders only and must be executed by the
object owner or an administrator with the required grant option.

## MCP pattern

The node is deliberately **not** exposed directly as an unrestricted AI tool. For MCP, wrap fixed
sub-workflows behind n8n's **MCP Server Trigger** and publish narrow tools such as:

- `get_company_codes` — fixed object, fixed columns, fixed row limit;
- `get_recent_sales_orders` — approved projection and deterministic sorting;
- `get_ledger_sample` — fixed company/year filters and bounded output.

Do not publish a `run_sql` tool. The HANA credential, schema allowlist, node limits, sub-workflow
input schema, and MCP authentication are separate layers and should all remain in place.

## Development and release

The project was scaffolded with the official n8n node CLI. The build compiles the node and bundles
the pure-JavaScript HANA driver while leaving `n8n-workflow` external.

Before a release:

```bash
npm run lint
npm test
npm run build
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[CHANGELOG.md](CHANGELOG.md).

The intended public repository is
`https://github.com/logali/n8n-nodes-hana-secure`. The first npm publication requires a
Logali-owned npm account; after that bootstrap release, configure npm Trusted Publishing for the
public GitHub repository and `publish.yml`. Subsequent version tags publish through short-lived
OIDC credentials with provenance instead of a long-lived npm token.

## License and trademarks

This project is licensed under the MIT License. See [LICENSE.md](LICENSE.md).

The bundled `hdb` driver is licensed under Apache License 2.0. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

SAP and SAP HANA are trademarks or registered trademarks of SAP SE in Germany and other countries.
This independent community project is not affiliated with, sponsored by, or endorsed by SAP SE or
n8n.
