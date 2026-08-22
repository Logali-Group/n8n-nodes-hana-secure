import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const nodeSource = readFileSync(
	new URL('../nodes/HanaSecure/HanaSecure.node.ts', import.meta.url),
	'utf8',
);
const credentialSource = readFileSync(
	new URL('../credentials/HanaSecureApi.credentials.ts', import.meta.url),
	'utf8',
);

const lightIcon = readFileSync(
	new URL('../nodes/HanaSecure/logaliHanaGuard-v092.svg', import.meta.url),
	'utf8',
);
const darkIcon = readFileSync(
	new URL('../nodes/HanaSecure/logaliHanaGuard-v092.dark.svg', import.meta.url),
	'utf8',
);
const credentialIcon = readFileSync(
	new URL('../credentials/logaliHanaGuardCredential-v092.svg', import.meta.url),
	'utf8',
);

describe('HANA Guard icon family', () => {
	it('uses the approved versioned artwork on the node and credential', () => {
		assert.match(nodeSource, /file:logaliHanaGuard-v092\.svg/);
		assert.match(nodeSource, /file:logaliHanaGuard-v092\.dark\.svg/);
		assert.match(credentialSource, /file:logaliHanaGuardCredential-v092\.svg/);
		assert.equal(lightIcon, darkIcon);
		assert.equal(lightIcon, credentialIcon);
		const png = Buffer.from(lightIcon.match(/base64,([^"']+)/)?.[1] ?? '', 'base64');
		assert.equal(png.readUInt32BE(16), 1024);
		assert.equal(png.readUInt32BE(20), 1024);
		assert.equal(
			createHash('sha256').update(png).digest('hex'),
			'faba4a5083189a4981770ef4662c89021b5d326d0c28579343f7e985a3acf9fc',
		);
	});
});
