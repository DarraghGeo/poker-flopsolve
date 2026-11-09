/**
 * The repository's coding conventions, checked.
 *
 * Purpose: `npm run lint`. The type checker (`npm run check`) already
 * refuses unused locals, parameters and imports (see `tsconfig.json`); this
 * checks what it cannot see:
 *
 * - file names are kebab-case: `history-merge.ts`, not `historyMerge.ts`;
 * - code is indented with tabs (doc-comment continuations and the text of
 *   template literals aside);
 * - no line ends in whitespace, and every file ends in one newline;
 * - no test is left focused (`it.only`, `describe.only`), which would skip
 *   the rest of the suite without failing it;
 * - no `debugger` statement.
 *
 *   npm run lint
 *
 * Prints each problem as `file:line: message` and exits 1 if there is any.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = new URL('..', import.meta.url).pathname;
const DIRECTORIES = ['src', 'test', 'bin', 'scripts', 'ui', 'examples', 'assembly', 'bench'];
const SKIP = new Set(['node_modules', 'dist', 'scratch', 'target', 'results', 'out', 'logs']);
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)*\.(ts|js)$/;

/** Every `.ts` and `.js` file under `dir`, skipping build output and recorded results. */
function sources(dir: string): string[] {
	const found: string[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (SKIP.has(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...sources(path));
		else if (/\.(ts|js)$/.test(entry.name)) found.push(path);
	}
	return found;
}

/**
 * Lines (0-based) that start inside a template literal, whose text is not
 * code, and lines holding a `debugger` statement.
 */
function scan(file: ts.SourceFile): { template: Set<number>; debuggers: number[] } {
	const template = new Set<number>();
	const debuggers: number[] = [];
	const lineOf = (position: number): number => file.getLineAndCharacterOfPosition(position).line;
	const visit = (node: ts.Node): void => {
		if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
			for (let line = lineOf(node.getStart(file)) + 1; line <= lineOf(node.getEnd()); line++) template.add(line);
		}
		if (node.kind === ts.SyntaxKind.DebuggerStatement) debuggers.push(lineOf(node.getStart(file)));
		ts.forEachChild(node, visit);
	};
	visit(file);
	return { template, debuggers };
}

const problems: string[] = [];
for (const path of DIRECTORIES.flatMap((dir) => sources(join(ROOT, dir)))) {
	const name = relative(ROOT, path);
	const report = (line: number, message: string): void => {
		problems.push(`${name}:${line + 1}: ${message}`);
	};
	if (!KEBAB.test(basename(path))) report(0, 'file names are kebab-case');

	const text = readFileSync(path, 'utf8');
	if (text.length > 0 && !text.endsWith('\n')) report(text.split('\n').length - 1, 'end the file with a newline');
	if (text.endsWith('\n\n')) report(text.split('\n').length - 2, 'end the file with one newline, not several');

	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	const { template: inTemplate, debuggers } = scan(source);
	for (const line of debuggers) report(line, 'remove the debugger statement');
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/[ \t]+$/.test(line)) report(i, 'trailing whitespace');
		if (inTemplate.has(i)) continue;
		// A doc comment's continuation lines are a space and a star.
		if (/^\t* +(?!\*)\S/.test(line)) report(i, 'indent with tabs');
		if (/^test\//.test(name) && /\b(it|describe|test)\.only\(/.test(line)) report(i, 'a focused test skips the rest of the suite');
	}
}

for (const problem of problems) console.error(problem);
if (problems.length > 0) {
	console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}`);
	process.exit(1);
}
console.log('lint: clean');
