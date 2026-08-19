# Changelog

All notable changes to this project will be documented in this file.

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
