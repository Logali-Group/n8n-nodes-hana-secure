# Contributing

Thanks for helping improve Logali HANA Guard.

## Ground rules

- Do not commit credentials, hosts, ports, certificates, customer names, or business data.
- Keep all default operations read-only.
- New query operations must use prepared parameters for values and validated identifiers for SQL
  structure.
- Do not weaken TLS validation, timeouts, row limits, or the advanced-SQL opt-in.
- Do not enable `usableAsTool` without a separate threat model and explicit policy controls.
- Add tests for every security-relevant parser or query-builder change.

## Development

Use Node.js 22 or later:

```bash
npm install
npm test
npm run lint
npm run build
```

The final command compiles the official n8n node structure and bundles the pure-JavaScript HANA
driver. Before opening a pull request, also run:

```bash
npm pack --dry-run
```

## Pull requests

Describe:

- the user problem;
- the HANA versions or deployment modes tested;
- the exact security impact;
- how the behavior was tested;
- any documentation or example changes.

Use only sanitized fixtures and screenshots.
