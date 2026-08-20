# Changelog

All notable changes to this project will be documented in this file.

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
