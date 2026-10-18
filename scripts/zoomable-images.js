/* Wraps every image in a post or page body in <button class="img-zoom">, which
 * is what the lightbox in js/site.js listens for. This is the Hexo counterpart
 * of the Hugo site's layouts/_markup/render-image.html.
 *
 * It is a button rather than a div so that opening an image works from the
 * keyboard and is announced as a control; without the script it stays an inert
 * wrapper and the image still shows, so nothing depends on JS to read the post.
 */

// Images that are already a link's content are left alone: those are meant to
// navigate, not to zoom.
const LINKED = /<a\b[^>]*>\s*<img\b[^>]*>\s*<\/a>/gi;
const IMG = /<img\b([^>]*)>/gi;

function wrap(html) {
  if (!html) return html;

  const parked = [];
  let out = html.replace(LINKED, m => {
    parked.push(m);
    return `\u0000LINKED${parked.length - 1}\u0000`;
  });

  out = out.replace(IMG, (match, attrs) => {
    const alt = (attrs.match(/alt="([^"]*)"/i) || [, ''])[1];
    // markdown-it emits neither, and a dev log carries a dozen diagrams.
    let img = match;
    if (!/\bloading=/i.test(attrs)) img = img.replace(/>$/, ' loading="lazy">');
    if (!/\bdecoding=/i.test(attrs)) img = img.replace(/>$/, ' decoding="async">');
    return `<button type="button" class="img-zoom" aria-label="Enlarge image: ${alt}">${img}</button>`;
  });

  return out.replace(/\u0000LINKED(\d+)\u0000/g, (_, i) => parked[i]);
}

hexo.extend.filter.register('after_post_render', function (data) {
  data.content = wrap(data.content);
  return data;
});
