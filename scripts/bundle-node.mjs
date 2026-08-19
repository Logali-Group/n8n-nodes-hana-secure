import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await build({
	entryPoints: ['nodes/HanaSecure/HanaSecure.node.ts'],
	outfile: 'dist/nodes/HanaSecure/HanaSecure.node.js',
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22',
	external: ['n8n-workflow'],
	legalComments: 'linked',
	sourcemap: true,
	allowOverwrite: true,
});

await copyFile('node_modules/hdb/LICENSE', 'dist/THIRD_PARTY_HDB_APACHE-2.0.txt');
