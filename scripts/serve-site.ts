/**
 * Serve the built benchmark page on localhost, as GitHub Pages would.
 *
 * Purpose: try the page before it ships. Pages sends no cross-origin
 * isolation headers, so neither does this by default: the page's own service
 * worker (site/coi-sw.js) has to supply them, exactly as in production.
 * `--isolated` sends them from the server instead.
 *
 *   npm run site                       # build, then serve on http://localhost:5175
 *   npm run site -- --port 8080 --isolated
 */

import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISOLATION_HEADERS } from './browser-harness.ts';
import { buildSite, SITE_OUT } from './build-site.ts';

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.map': 'application/json',
};

/** Serve `site/dist/`; resolves once listening. */
export async function serveSite(options: { port?: number; isolated?: boolean } = {}): Promise<{ url: string; server: Server }> {
	const server = createServer((request, response) => {
		let path: string;
		try {
			path = decodeURIComponent((request.url ?? '/').split('?')[0]);
		} catch {
			return void response.writeHead(400).end();
		}
		const file = normalize(join(SITE_OUT, path.endsWith('/') ? `${path}index.html` : path));
		if (!file.startsWith(SITE_OUT + sep)) return void response.writeHead(403).end();
		try {
			if (!statSync(file).isFile()) throw new Error('not a file');
		} catch {
			return void response.writeHead(404).end();
		}
		response.writeHead(200, {
			'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
			'cache-control': 'no-store',
			...(options.isolated ? ISOLATION_HEADERS : {}),
		});
		response.end(readFileSync(file));
	});
	await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return { url: `http://localhost:${port}/`, server };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = process.argv.slice(2);
	const at = args.indexOf('--port');
	await buildSite();
	const { url } = await serveSite({ port: at >= 0 ? Number(args[at + 1]) : 5175, isolated: args.includes('--isolated') });
	console.log(`Benchmark page on ${url} (Ctrl-C to stop)`);
}
