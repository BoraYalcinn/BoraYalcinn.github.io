/* Template helpers ported from the Hugo site's partials. */

// Hexo attaches tag models to posts only, so a page's `tags` is still the plain
// front-matter array while a post's is a Query. Both shapes reach the layouts.
const tagNames = tags => !tags ? []
  : (typeof tags.toArray === 'function' ? tags.toArray().map(t => t.name) : [].concat(tags));

// Tag links, for posts and pages alike. A tag that has its own /tags/ page
// links to it; one used only on a page is plain text, since Hexo builds a term
// page for post tags only.
hexo.extend.helper.register('tag_links', function (tags, separator) {
  const names = tagNames(tags);
  if (!names.length) return '';

  const dir = hexo.config.tag_dir || 'tags';
  const known = new Map(hexo.locals.get('allTags').map(t => [t.name.toLowerCase(), `${dir}/${t.slug}/`]));

  return names.map(name => {
    const path = known.get(String(name).toLowerCase());
    return path
      ? `<a class="tag-none-link" href="${this.url_for(path)}">${name}</a>`
      : `<span class="tag-none-link is-plain">${name}</span>`;
  }).join(separator || ', ');
});

// The technology badges for one repo on /projects/. A tag that only repeats the
// repo's GitHub language is skipped: the language already sits next to the title
// in a badge of its own, and a row reading "C++  c++  sdl2" helps nobody.
// A tag links to its /tags/ page when something under source/ carries the same
// tag, and is plain text otherwise, since Hexo only builds a term page for tags
// that are actually used.
hexo.extend.helper.register('repo_tags', function (tags, language, wrap) {
  const lang = (language || '').toLowerCase();
  const visible = (tags || []).filter(t => String(t).toLowerCase() !== lang);
  if (!visible.length) return '';

  const dir = hexo.config.tag_dir || 'tags';
  const known = new Map(hexo.locals.get('allTags').map(t => [t.name.toLowerCase(), `${dir}/${t.slug}/`]));

  const badges = visible.map(tag => {
    const path = known.get(String(tag).toLowerCase());
    return path
      ? `<a class="badge" href="${this.url_for(path)}">${tag}</a>`
      : `<span class="badge">${tag}</span>`;
  }).join('');

  return wrap ? `<div class="${wrap}">${badges}</div>` : badges;
});

// One Shadertoy shader, in whichever of three modes the page supplies.
//
// Why not the live iframe by default: Shadertoy sits behind Cloudflare, and a
// cross-origin iframe reaches it without Shadertoy's cookies, so Cloudflare
// answers with a bot challenge and that challenge page refuses to be framed.
// The visitor gets "refused to connect". Opening the same embed URL in a tab
// works, which is why linking out is a fair substitute.
//
//   video   a recorded loop (webm), the default when one is given
//   cover   a still image
//   blank   a dark panel with the shader id
//
// `shaderEmbed: true` opts a page back into the live iframe.
hexo.extend.helper.register('shadertoy', function (opts) {
  const id = opts.id;
  const title = opts.title || `Shadertoy shader ${id}`;
  const url = `https://www.shadertoy.com/view/${id}`;
  const u = p => this.url_for(p);
  let frame;

  if (opts.embed) {
    const gui = String(opts.gui) === 'false' ? 'false' : 'true';
    const paused = String(opts.paused) === 'true' ? 'true' : 'false';
    frame = `<div class="shadertoy-frame">
      <iframe src="https://www.shadertoy.com/embed/${id}?gui=${gui}&t=10&paused=${paused}&muted=true"
              title="${title}" loading="lazy" allowfullscreen allow="fullscreen"></iframe>
    </div>`;
  } else if (opts.video) {
    // muted + playsinline are what make autoplay allowed at all; the poster is
    // what a reduced-motion visitor is left looking at once the script below
    // pauses it.
    frame = `<div class="shadertoy-frame shadertoy-video">
      <video src="${u(opts.video)}" ${opts.cover ? `poster="${u(opts.cover)}"` : ''}
             autoplay loop muted playsinline preload="metadata"
             aria-label="${title}, recorded"></video>
    </div>`;
  } else {
    const inner = opts.cover
      ? `<img src="${u(opts.cover)}" alt="" loading="lazy" decoding="async">`
      : `<span class="shadertoy-poster-blank" aria-hidden="true">${id}</span>`;
    frame = `<a class="shadertoy-frame shadertoy-poster" href="${url}" rel="noopener" target="_blank">
      ${inner}<span class="shadertoy-play" aria-hidden="true">&#9654;</span>
      <span class="sr-only">Run ${title} on Shadertoy</span>
    </a>`;
  }

  // A looping autoplay video is exactly what prefers-reduced-motion is about;
  // CSS cannot stop playback, so this pauses it and hands the visitor controls
  // instead. Guarded so it is a no-op past the first.
  const reducedMotion = `<script>
    (function () {
      if (window.__shadertoyRM) return;
      window.__shadertoyRM = true;
      try { if (!matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch (e) { return; }
      var pause = function () {
        document.querySelectorAll('.shadertoy-video video').forEach(function (v) {
          v.autoplay = false; v.controls = true; v.pause();
        });
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pause);
      else pause();
    })();
  </script>`;

  return `<figure class="shadertoy">${frame}${reducedMotion}
    <figcaption><a href="${url}" rel="noopener" target="_blank">${title} — open on Shadertoy</a></figcaption>
  </figure>`;
});
