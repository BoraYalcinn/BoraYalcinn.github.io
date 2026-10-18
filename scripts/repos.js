/* The /projects/ repo list, ported from the Hugo site's partials/func/repos.html.
 *
 * Exposes `projects` to the templates as:
 *
 *     { featured: [...], rest: [...], all: [...], live: bool }
 *
 * Each entry: name, title, description, url, language, tags, stars, archived, page, cover.
 *
 * The list is fetched from the GitHub API at build time, then merged with
 * source/_data/projects.yml (hidden, showForks, overrides, featured order).
 *
 * Why a snapshot fallback: an unauthenticated GitHub API allows 60 requests an
 * hour per IP and CI runners share addresses, so a deploy can lose the call
 * through no fault of the site. Falling back to _data/reposSnapshot.json means a
 * rate-limited or offline build still ships a complete page instead of an empty
 * one. Set GITHUB_TOKEN in CI to raise the limit and keep the live path.
 */

let raw = [];
let live = false;

hexo.extend.filter.register('before_generate', async function () {
  const data = this.locals.get('data') || {};
  const cfg = data.projects || {};
  const user = cfg.user || 'BoraYalcinn';
  const url = `https://api.github.com/users/${user}/repos?per_page=100&sort=updated`;

  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'hexo-build' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
    live = true;
    hexo.log.info(`projects: ${raw.length} repos from the GitHub API`);
  } catch (err) {
    hexo.log.warn(`projects: GitHub API unreachable (${err.message}); falling back to _data/reposSnapshot.json`);
    raw = data.reposSnapshot || [];
    live = false;
    if (!raw.length) hexo.log.warn('projects: no snapshot either, the repo list will be empty');
  }
});

hexo.locals.set('projects', function () {
  const data = hexo.locals.get('data') || {};
  const cfg = data.projects || {};
  const hidden = cfg.hidden || [];
  const showForks = cfg.showForks || [];

  const overrides = {};
  for (const o of cfg.overrides || []) if (o.repo) overrides[o.repo] = o;

  // A repo may have a write-up page here, matched by `repo:` in its front
  // matter; the card then points at that page instead of at GitHub.
  const writeups = {};
  hexo.locals.get('pages').each(p => { if (p.repo) writeups[p.repo] = p; });

  const items = [];
  for (const r of raw) {
    if (hidden.includes(r.name)) continue;
    if (r.fork && !showForks.includes(r.name)) continue;

    const o = overrides[r.name] || {};
    const page = writeups[r.name];

    // The page's own cover wins over one named in the data file, so a project
    // with a write-up is illustrated the same way a post is. Tags work the
    // other way round: the data file is the override, so a repo without one
    // keeps a single list of tags, on its write-up.
    let cover = o.cover || '';
    let tags = o.tags || [];
    if (page) {
      if (page.cover) cover = page.cover;
      // Hexo attaches tag models to posts only, so a page's `tags` is still the
      // plain front-matter array; both shapes turn up depending on when this
      // runs.
      if (!tags.length && page.tags) {
        tags = typeof page.tags.toArray === 'function'
          ? page.tags.toArray().map(t => t.name)
          : [].concat(page.tags);
      }
    }

    items.push({
      name: r.name,
      title: o.title || r.name,
      description: o.description || r.description || '',
      url: o.url || r.html_url,
      page: page ? page.path : '',
      cover,
      language: r.language || '',
      tags,
      stars: r.stargazers_count || 0,
      archived: r.archived || false
    });
  }

  const featuredNames = cfg.featured || [];
  const featured = featuredNames.map(n => items.find(i => i.name === n)).filter(Boolean);
  const rest = items.filter(i => !featuredNames.includes(i.name));

  return { featured, rest, all: featured.concat(rest), live };
});
