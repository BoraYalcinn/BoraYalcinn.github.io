/* Inline math written as \(...\) , rewritten to $...$ before the markdown
 * renderer sees it.
 *
 * The Hugo site accepted \(...\) for inline math and deliberately refused a
 * bare $...$ pair, so that "$5 to $10" in an ordinary sentence could never turn
 * into a formula. The posts are written that way throughout.
 *
 * @traptitech/markdown-it-katex only knows $ and $$. Given \(P\) it does not
 * fail loudly: markdown-it treats the backslashes as ordinary escapes, eats
 * them, and the reader gets a bare "(P)". This bridges the two so the posts
 * keep their own notation and still render.
 *
 * Fenced blocks and inline code are copied through untouched, since a
 * backslash-paren inside a code sample is code, not maths.
 */

// Fenced block, or inline code span, or anything else.
const SEGMENTS = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;

function rewrite(markdown) {
  return markdown
    .split(SEGMENTS)
    .map((segment, index) => {
      // The capture group means code segments land on odd indices.
      if (index % 2 === 1) return segment;
      return segment
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => `$$${body}$$`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => `$${body}$`);
    })
    .join('');
}

hexo.extend.filter.register('before_post_render', function (data) {
  if (data.content) data.content = rewrite(data.content);
  return data;
});
