/**
 * Small source-text helpers shared by the shader front end.
 *
 * Lives on its own so that both the preamble builder and the HLSL translator
 * can use it without importing each other - preamble needs the translator to
 * build a shader, and the translator needs this to decide whether a shader is
 * HLSL at all, which would otherwise be a cycle.
 */

/**
 * Remove comments before pattern-matching.
 *
 * Every decision made about a shader's text - which language it is, whether it
 * defines mainImage - has to ignore comments, or a `// void mainImage(...)`
 * note changes how the shader is wrapped.
 */
export function stripCommentsAndStrings(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}
