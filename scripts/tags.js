/* Tag pages over posts AND pages.
 *
 * Hexo's own tag generator indexes posts only, so under a plain install the
 * tags a project or shader page carries (java, glsl, lwjgl, ...) would simply
 * vanish from /tags/. The Hugo site listed them, and the data file for
 * /projects/ links repo tags to those same term pages, so this replaces
 * hexo-generator-tag rather than sitting beside it.
 */

const { slugize } = require('hexo-util');

const tagNames = tags => !tags ? []
  : (typeof tags.toArray === 'function' ? tags.toArray().map(t => t.name) : [].concat(tags));

hexo.extend.generator.register('tags', function (locals) {
  const dir = this.config.tag_dir || 'tags';
  const perPage = (this.config.tag_generator && this.config.tag_generator.per_page) || 10;

  // name -> { name, entries } , keyed case-insensitively so "C++" and "c++"
  // from two different sources do not split into two term pages.
  const groups = new Map();
  const add = (entry, names) => {
    for (const raw of names) {
      const key = String(raw).toLowerCase();
      if (!groups.has(key)) groups.set(key, { name: raw, entries: [] });
      groups.get(key).entries.push(entry);
    }
  };

  locals.posts.each(p => add(p, tagNames(p.tags)));
  locals.pages
    .filter(p => ['project', 'shader'].includes(p.layout))
    .each(p => add(p, tagNames(p.tags)));

  const pages = [];
  for (const { name, entries } of groups.values()) {
    const slug = slugize(name, { transform: 1 });
    const sorted = entries.sort((a, b) => (b.date - a.date));

    // Paginated the same way the post feed is, so a tag with many entries does
    // not grow without bound.
    const total = Math.max(1, Math.ceil(sorted.length / perPage));
    for (let i = 0; i < total; i++) {
      const path = i === 0 ? `${dir}/${slug}/` : `${dir}/${slug}/page/${i + 1}/`;
      pages.push({
        path,
        layout: ['tag', 'archive', 'index'],
        data: {
          __tag: true,
          tag: name,
          slug,
          posts: { each: fn => sorted.slice(i * perPage, (i + 1) * perPage).forEach(fn) },
          current: i + 1,
          total,
          base: `${dir}/${slug}/`,
          prev_link: i > 0 ? (i === 1 ? `${dir}/${slug}/` : `${dir}/${slug}/page/${i}/`) : '',
          next_link: i + 1 < total ? `${dir}/${slug}/page/${i + 2}/` : ''
        }
      });
    }
  }
  return pages;
});

// The /tags/ index reads this rather than site.tags, for the same reason.
hexo.locals.set('allTags', function () {
  const groups = new Map();
  const add = (entry, names) => {
    for (const raw of names) {
      const key = String(raw).toLowerCase();
      if (!groups.has(key)) groups.set(key, { name: raw, slug: slugize(raw, { transform: 1 }), count: 0 });
      groups.get(key).count++;
    }
  };
  hexo.locals.get('posts').each(p => add(p, tagNames(p.tags)));
  hexo.locals.get('pages')
    .filter(p => ['project', 'shader'].includes(p.layout))
    .each(p => add(p, tagNames(p.tags)));

  return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
});
