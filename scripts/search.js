/* The index /search/ reads. Posts, project pages and shader pages all go in,
 * which is what the Hugo site's search covered. Body text is stripped of markup
 * and capped: the whole site is a handful of pages, so an exact-substring
 * search over a small JSON file needs no search library. */

// Hexo attaches tag models to posts only, so a page's `tags` is still the plain
// front-matter array.
const tagNames = tags => !tags ? []
  : (typeof tags.toArray === 'function' ? tags.toArray().map(t => t.name) : [].concat(tags));

const stripHtml = html => String(html || '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

hexo.extend.generator.register('search_index', function (locals) {
  const entry = p => ({
    title: p.title || '',
    url: this.config.root + p.path,
    date: p.date ? p.date.format('YYYY-MM-DD') : '',
    description: p.description || '',
    tags: tagNames(p.tags),
    section: p.layout === 'post' ? 'Blog' : (p.layout === 'project' ? 'Projects' : 'Shaders'),
    body: stripHtml(p.content).slice(0, 6000)
  });

  const pages = locals.pages
    .filter(p => ['project', 'shader'].includes(p.layout))
    .toArray();

  const data = locals.posts.sort('date', -1).toArray().concat(pages).map(entry);

  return { path: 'search.json', data: JSON.stringify(data) };
});
