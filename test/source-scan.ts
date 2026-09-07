/**
 * Reading source as code, for the two tests that scan imports.
 *
 * Both `module-resolution.test.ts` and `client-bundle.test.ts` work by matching
 * import specifiers in source text, and both were briefly wrong in the same way:
 * this codebase comments densely, the comments discuss imports, and a quoted
 * specifier inside a sentence matched as though it were an import statement. One
 * doc comment in `furniture.ts` — a sentence naming the import it exists to
 * prevent — failed both suites at once.
 *
 * That is a bad failure mode to leave in place. It is not merely a false alarm:
 * it makes explaining a rule in prose break the rule, which is a tax on exactly
 * the documentation this project relies on.
 */

/**
 * A string literal, or a comment.
 *
 * The alternation is ordered, and that is the whole trick: a string literal is
 * tried first and kept, so only what is left over is a comment and gets dropped.
 * Matching comments alone would cut a URL in half at its `//`.
 *
 * Not a parser. A regex literal containing a lone quote could still confuse it —
 * accepted deliberately, because both callers guard the direction that matters:
 * each asserts it still reaches a plausible number of files, so a stripper that
 * started eating real code would show up as a suite that stopped looking rather
 * than as one that quietly passed.
 */
const STRING_OR_COMMENT =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/** The source with its comments blanked out and its string literals intact. */
export function code(source: string): string {
  return source.replace(STRING_OR_COMMENT, (match, literal: string | undefined) =>
    literal === undefined ? ' ' : literal,
  );
}
