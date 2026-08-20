# Changelog

All notable changes to this project will be documented in this file.

## [0.8.0] - 2026-08-20

### Added

- Add an optional three-digit **SAP Client** credential field for client-dependent ABAP CDS
  runtimes.
- Set both HANA `CLIENT` and `CDS_CLIENT` session variables on every connection when the field is
  configured, while leaving existing credentials unchanged when it is empty.
- Validate the client before opening a database connection and document that session context does
  not replace database grants or credential governance policies.

## [0.7.1] - 2026-08-20

### Fixed

- Recognize a valid HANA table function as a possible parameterized ABAP CDS runtime when semantic
  inspection does not find an SQL view or virtual table.
- Return its ordered catalog inputs from semantic parameter discovery with explicit table-function
  positional binding metadata.
- Correct the ABAP CDS country workflow to invoke `SAPHANADB.ZN8NCOUNTRYP` as a table function with
  the named `P_COUNTRY` input instead of treating it as a parameterized SQL view.
- Prioritize custom `Y*` and `Z*` table functions in editor choices so generated training objects
  remain selectable in schemas containing more than 500 functions.

### Changed

- Label table-function operations and the row source explicitly for parameterized ABAP CDS runtime
  objects while keeping the underlying governed HANA table-function contract unchanged.
- Allow an exact runtime name to be entered for semantic/CDS inspection after discovery through
  the bounded catalog operations.

## [0.7.0] - 2026-08-20

### Added

- Add governed discovery and description of valid HANA table functions.
- Add node version `1.4` with a table-function row source, catalog-ordered named scalar inputs, and
  prepared value binding.
- Reuse Select, Preview, Count, Exists, Distinct, Aggregate, key lookup, column/row policies,
  result caps, and composite pagination over table-function results.
- Add a sanitized n8n workflow and reviewed non-production SQLScript setup template.
- Add a parameterized ABAP CDS laboratory definition plus a sanitized workflow for its generated
  SQL runtime view; verify creation, syntax, activation, and a bounded `DE` lookup through ADT.

### Security

- Validate table-function metadata through `SYS.FUNCTIONS` and reject invalid, unknown, duplicate,
  missing, table-type, array, or excessive inputs before invocation.
- Require an explicit `Allowed Objects` entry before an AI Tool can discover, describe, or invoke a
  table function.
- Keep function implementation text out of catalog output and continue binding all values through
  prepared statements.

### Changed

- Clarify that SAP HANA Cloud SQL endpoints normally use TLS over TCP port `443`.
- Mark node version `1.4` as current while retaining versions `1`, `1.1`, `1.2`, and `1.3`.

## [0.6.0] - 2026-08-20

### Added

- Add stable composite-key pagination with opaque continuation tokens and bounded automatic page
  collection.
- Add SQL runtime, calculation-view, and virtual-table recognition for semantic/CDS-backed HANA
  objects, plus parameter discovery and prepared positional/placeholder execution.
- Add `Exists`, `Count`, `Distinct`, five-row `Preview`, multiple aggregates, constraint/key
  discovery, database information, and sanitized governance-policy inspection.
- Add explicit BIGINT, date/timestamp, and binary JSON conversion plus a workflow result-size cap.
- Add per-execution connection reuse, query counts/fingerprints, and safe error categories with
  retryability hints.
- Add a sanitized node v1.3 workflow demonstrating semantic inspection and automatic pagination.

### Security

- Validate semantic placeholder names while binding every value through prepared statements.
- Enforce maximum automatic rows/pages and serialized workflow result size.
- Redact credentials and endpoints from driver errors returned through `Continue On Fail`.

### Changed

- Mark node version `1.3` as current while retaining versions `1`, `1.1`, and `1.2`.
- Discover governed HANA virtual tables and columns alongside tables and views.

## [0.5.0] - 2026-08-20

### Added

- Load governed schemas, tables, views, and column choices directly from HANA in the node editor.
- Add **Get One by Key** with typed simple or composite equality keys and duplicate detection.
- Add three output modes: one item per row, all rows in one item, or rows added to the input item.
- Add a sanitized demo workflow for key lookup and input enrichment.

### Changed

- Update the installation guide for the public npm package and Trusted Publishing release flow.
- Mark node version `1.2` as the current version while retaining versions `1` and `1.1`.

### Security

- Apply object, column, and credential-required row policies to dynamic editor choices and key reads.
- Reject duplicate key fields, non-unique key matches, and unsafe output field names.

## [0.4.0] - 2026-08-20

### Added

- Add exact `SCHEMA.OBJECT` allowlists for catalog and structured row operations.
- Add object-scoped column policies that govern selection, filters, sorting, grouping,
  aggregation, and pagination cursors.
- Add credential-required filters that are always combined with user filters using `AND`.
- Add typed filter values, `AND`/`OR` user-filter logic, `IN`, `NOT IN`, `BETWEEN`, `NOT LIKE`,
  and literal contains/starts-with/ends-with operators.
- Add single-column keyset pagination with `hasMore` and `nextCursor` result metadata.
- Add `COUNT(DISTINCT ...)`, query duration, policy status, and source details to result metadata.
- Add HANA column comments and default values to Describe when the server exposes them, with a
  compatibility fallback for older catalog schemas.
- Add a separate AI catalog-discovery switch and a serialized-result byte cap.
- Validate policy syntax, cross-policy consistency, and AI limits during credential testing and
  before every execution.

### Security

- Apply object, column, and required-filter policies to normal structured reads and AI Tool calls.
- Fail closed when a governance policy is malformed or an identifier falls outside its policy.
- Block advanced SQL in node v1.1+ when structured credential policies are present, because an
  arbitrary SELECT cannot honestly guarantee object, column, and row-policy enforcement.
- Keep existing node v1 workflows compatible while new nodes use the stricter v1.1 AI catalog
  and result-size controls.

## [0.3.1] - 2026-08-19

### Changed

- Point package metadata, issue reporting, credential help, and node documentation to the verified
  corporate GitHub account `Logali-Group`.
- Keep `0.3.0` as the exact internally deployed artifact and use `0.3.1` for the first public
  release candidate so two different packages never share the same version.

## [0.3.0] - 2026-08-19

### Added

- Generate **Logali HANA Guard Tool** as a native n8n AI Agent Tool from the existing node.
- Add an explicit credential switch for AI Tool use and a credential-level Tool row cap.
- Add policy tests for normal-node compatibility, explicit opt-in, default limits, and SQL denial.

### Security

- Reject SQL (Advanced) unconditionally in the AI Tool variant, even when a normal workflow may
  use the same credential for guarded read-only SQL.
- Keep Connection, Catalog, Select Rows, and Aggregate Rows available while preserving schema
  allowlists, prepared filters, timeouts, database grants, and enforced result limits.

## [0.2.3] - 2026-08-19

### Fixed

- Preserve the official Logali mark without redrawing, moving, or cutting its geometry.
- Move the database symbol into a separate lower-right badge so the product purpose remains visible
  without altering the company identity.

## [0.2.2] - 2026-08-19

### Fixed

- Version the physical icon filenames so n8n and browser caches cannot keep displaying the
  pre-brand artwork after a package upgrade.

## [0.2.1] - 2026-08-19

### Fixed

- Replace the overly generic database icon with a high-contrast Logali nut mark combined with the
  guarded database symbol, optimized to remain recognizable in n8n at 24–32 pixels.

## [0.2.0] - 2026-08-19

### Added

- Introduce the public **Logali HANA Guard** name and original database/hexagon brand mark.
- Add sanitized webinar workflows for schema discovery, approved-object inventory, and a guarded
  HANA-versus-OData comparison.
- Add a literal object-name prefix and a hard result limit to table/view catalog discovery.

### Changed

- Prepare CI and npm Trusted Publishing with tests, package inspection, OIDC, and provenance.
- Document the verified `insufficient privilege` boundary: catalog visibility does not imply
  permission to read S/4 application tables.

## [0.1.6] - 2026-08-19

### Changed

- Synchronize the packaged README with the verified HANA 2.00.088 deployment, NAT guidance, and
  pinned `hdb@2.27.1` compatibility note.

## [0.1.5] - 2026-08-19

### Fixed

- Read the active database name from `SYS.M_DATABASE` in the connection test. SAP HANA 2.0 SPS08
  does not expose `CURRENT_DATABASE` as the scalar pseudo-column used by the previous query.

## [0.1.4] - 2026-08-19

### Fixed

- Close `hdb` clients synchronously after a completed request. The driver aliases `end()` to
  `close()` and never invokes the callback the node previously waited for, leaving successful n8n
  executions stuck in `Running`.

## [0.1.3] - 2026-08-19

### Fixed

- Pin SAP `hdb` to the signed `2.27.1` release, before the `2.29.x` physical-connection and
  topology rewrite that stalled authenticated sessions through the laboratory NAT endpoint.

## [0.1.2] - 2026-08-19

### Fixed

- Disable tenant/cloud redirects together with topology discovery when the configured endpoint is
  behind NAT or port forwarding.
- Settle timeout failures before closing the underlying socket so a stalled cleanup cannot keep an
  n8n execution running.

## [0.1.1] - 2026-08-19

### Fixed

- Keep NAT, port-forwarded, proxy, and managed endpoints on the configured host instead of
  following internal HANA topology addresses.
- Enforce the configured connection timeout across the complete authentication handshake.
- Send the application session variable using the flat key expected by the `hdb` driver.

## [0.1.0] - 2026-07-30

### Added

- Initial self-hosted n8n community node for SAP HANA.
- TLS-aware credentials, schema allowlist, timeouts, and connection test.
- Catalog, structured read, aggregation, and opt-in advanced read-only SQL operations.
- Parameter binding, identifier validation, hard row limits, and SQL safety tests.
