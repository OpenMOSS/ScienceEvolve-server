// Normalize LaTeX delimiters before Markdown consumes the backslashes.
// Match code and escaped backslashes first so literal examples stay intact.
export function normalizeMarkdownMath(markdown: string): string {
  return markdown.replace(
    /(^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\2[`~]*[ \t]*(?=\r?$)|$(?![\s\S]))|(`+)(?!`)[\s\S]*?(?<!`)\3(?!`)|\\\\)|\\\(([^\r\n]+?)\\\)|\\\[([\s\S]+?)\\\]/gm,
    (match, literal: string | undefined, _fence, _code, inline: string | undefined, display: string | undefined) => {
      if (literal) return match;
      if (inline !== undefined) return `$${inline}$`;
      return `\n\n$$\n${display?.trim()}\n$$\n\n`;
    }
  );
}
