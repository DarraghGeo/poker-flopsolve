/**
 * Local solver UI server.
 *
 * Purpose: put the solver behind a few JSON endpoints and serve the page.
 *
 * Each solve gets its own worker thread. Solving blocks whichever thread it
 * runs on, so keeping it off the server's loop is what lets progress be polled
 * while a large spot is still running. The worker also retains the run
 * afterwards and answers strategy queries, since a Solution cannot be
 * serialised across threads.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { defineSpot } from '../src/index.ts';
import type { SpotConfig } from '../src/index.ts';

const PORT = Number(process.env.PORT ?? 5174);

/** Solved sessions are kept so the page can browse them; older ones are dropped. */
const MAX_SESSIONS = 4;

interface Session {
	readonly id: string;
	readonly worker: Worker;
	status: 'building' | 'solving' | 'ready' | 'error';
	summary: unknown;
	nodes: unknown;
	combos: unknown;
	result: unknown;
	progress: unknown;
	error: string | null;
	readonly pending: Map<number, (value: unknown) => void>;
	nextRequestId: number;
}

const sessions = new Map<string, Session>();
let counter = 0;

/** A few spots worth opening with. */
const PRESETS: Record<string, SpotConfig & { iterations?: number; targetPercent?: number }> = {
	'River: polarised': {
		board: '2c 7d 9h Js 3c', pot: 100, stack: 75,
		oop: 'JJ,54s', ip: 'TT',
		betSizes: [[0.75]], maxRaises: 1, iterations: 3000,
	},
	'River: wide': {
		board: 'As Kh 7d 2c 9s', pot: 80, stack: 100,
		oop: '22+,A2s+,KTs+,AJo+', ip: '22+,A8s+,KJs+,ATo+',
		betSizes: [[0.33, 0.75]], maxRaises: 1, iterations: 1500,
	},
	'Turn: single raise': {
		board: 'As Kh 7d 2c', pot: 60, stack: 120,
		oop: '22+,A2s+,K9s+,QTs+,JTs,T9s,98s,AJo+,KQo',
		ip: '22+,A8s+,KTs+,QTs+,JTs,T9s,ATo+,KJo+',
		betSizes: [[0.5, 1.0]], maxRaises: 1, iterations: 500,
	},
	'Flop: narrow': {
		board: 'As Kh 7d', pot: 60, stack: 100,
		oop: 'AA,KK,QQ,AKs,AQs,KQs,76s,65s', ip: 'JJ,TT,99,AJs,KJs,QJs,JTs,T9s',
		betSizes: [[0.66]], maxRaises: 1, iterations: 400, targetPercent: 0.5,
	},
};

function createSession(config: SpotConfig, iterations: number, targetPercent: number): Session {
	const id = `s${++counter}`;
	const worker = new Worker(fileURLToPath(new URL('./session.ts', import.meta.url)), {
		workerData: { config, iterations, targetPercent },
	});

	const session: Session = {
		id, worker, status: 'building',
		summary: null, nodes: null, combos: null, result: null, progress: null, error: null,
		pending: new Map(), nextRequestId: 0,
	};

	worker.on('message', (message: Record<string, unknown>) => {
		switch (message.type) {
			case 'built':
				session.summary = message.summary;
				session.nodes = message.nodes;
				session.combos = { oop: message.oopCombos, ip: message.ipCombos };
				session.status = 'solving';
				break;
			case 'progress':
				session.progress = message;
				break;
			case 'done':
				session.result = message;
				session.status = 'ready';
				break;
			case 'error':
				session.error = String(message.message);
				session.status = 'error';
				break;
			case 'strategy': {
				const resolve = session.pending.get(message.id as number);
				if (resolve) {
					session.pending.delete(message.id as number);
					resolve(message);
				}
				break;
			}
		}
	});
	worker.on('error', (error) => {
		session.error = error.message;
		session.status = 'error';
	});

	sessions.set(id, session);
	while (sessions.size > MAX_SESSIONS) {
		const [oldest, value] = sessions.entries().next().value as [string, Session];
		void value.worker.terminate();
		sessions.delete(oldest);
	}
	return session;
}

function requestStrategy(session: Session, node: number, board: number): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (session.status === 'building' || session.status === 'error') {
			reject(new Error('this spot has nothing to show yet'));
			return;
		}
		const id = session.nextRequestId++;
		session.pending.set(id, resolve);
		session.worker.postMessage({ kind: 'query', id, node, board });
		setTimeout(() => {
			if (session.pending.delete(id)) reject(new Error('strategy request timed out'));
		}, 30_000);
	});
}

async function readJson(stream: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(chunk as Buffer);
	return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = createServer((request, response) => {
	const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
	const json = (status: number, body: unknown): void => {
		const text = JSON.stringify(body);
		response.writeHead(status, {
			'content-type': 'application/json',
			'content-length': Buffer.byteLength(text),
		});
		response.end(text);
	};

	void (async () => {
		try {
			if (url.pathname === '/' || url.pathname === '/index.html') {
				const page = await readFile(fileURLToPath(new URL('./index.html', import.meta.url)));
				response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				response.end(page);
				return;
			}
			if (url.pathname === '/grid.js') {
				const module = await readFile(fileURLToPath(new URL('./grid.js', import.meta.url)));
				response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
				response.end(module);
				return;
			}
			if (url.pathname === '/favicon.ico') {
				response.writeHead(204);
				response.end();
				return;
			}
			if (url.pathname === '/api/presets') {
				json(200, PRESETS);
				return;
			}
			if (url.pathname === '/api/estimate' && request.method === 'POST') {
				const body = await readJson(request);
				try {
					json(200, { ok: true, estimate: defineSpot(body.config as SpotConfig).estimate });
				} catch (error) {
					json(200, { ok: false, message: (error as Error).message });
				}
				return;
			}
			if (url.pathname === '/api/solve' && request.method === 'POST') {
				const body = await readJson(request);
				const session = createSession(
					body.config as SpotConfig,
					Number(body.iterations ?? 500),
					Number(body.targetPercent ?? 0),
				);
				json(200, { id: session.id });
				return;
			}
			if (url.pathname === '/api/control' && request.method === 'POST') {
				const body = await readJson(request);
				const session = sessions.get(String(body.id ?? ''));
				if (!session) {
					json(404, { message: 'no such session' });
					return;
				}
				session.worker.postMessage({ kind: 'control', action: body.action });
				json(200, { ok: true });
				return;
			}
			if (url.pathname === '/api/status') {
				const session = sessions.get(url.searchParams.get('id') ?? '');
				if (!session) {
					json(404, { message: 'no such session' });
					return;
				}
				json(200, {
					status: session.status,
					summary: session.summary,
					nodes: session.nodes,
					combos: session.combos,
					progress: session.progress,
					result: session.result,
					error: session.error,
				});
				return;
			}
			if (url.pathname === '/api/strategy') {
				const session = sessions.get(url.searchParams.get('id') ?? '');
				if (!session) {
					json(404, { message: 'no such session' });
					return;
				}
				json(200, await requestStrategy(
					session,
					Number(url.searchParams.get('node')),
					Number(url.searchParams.get('board') ?? 0),
				));
				return;
			}
			json(404, { message: 'not found' });
		} catch (error) {
			json(500, { message: (error as Error).message });
		}
	})();
});

server.listen(PORT, () => {
	console.log(`\n  hold'em solver  →  http://localhost:${PORT}\n`);
});
