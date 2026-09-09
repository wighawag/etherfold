import ts from 'typescript';

/**
 * A file's CODE, with every comment removed, for a gate that forbids a word.
 *
 * ## Why a gate needs this
 *
 * These packages carry text-scanning gates that assert a forbidden thing is
 * absent from `src/` -- no `D1`, no `cloudflare`, no `console.`. Run against the
 * raw file they scan PROSE as well as code, so the sentence explaining WHY this
 * store must never name D1 fails the gate that exists to keep it from naming D1.
 * The gate then teaches the opposite of its own rule: it punishes the comment
 * that would stop someone reintroducing the dependency, and the cheapest way to
 * get green is to delete the explanation.
 *
 * That is a bad trade for a check whose whole value is being explainable, so the
 * comments come out before the match.
 *
 * ## What is deliberately KEPT
 *
 * String literals stay. `'D1Database'` in a string is a real reference and a
 * gate that ignored it could be defeated by quoting. Only comment trivia is
 * dropped, which is exactly the difference between what a program DOES and what
 * a human wrote about it.
 *
 * Tokens are re-joined with a space rather than reproducing the original
 * spacing, so a matcher must not depend on layout -- the anchored
 * `^\s*import ... from '...'` scans keep reading the RAW source for that reason,
 * and they are already safe because an import is not a comment.
 */
export function codeOnly(source: string): string {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ true, ts.LanguageVariant.Standard, source);
	const tokens: string[] = [];
	let token = scanner.scan();
	while (token !== ts.SyntaxKind.EndOfFileToken) {
		tokens.push(scanner.getTokenText());
		token = scanner.scan();
	}
	return tokens.join(' ');
}
