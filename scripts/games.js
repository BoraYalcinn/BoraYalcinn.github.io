/* Games releasing next month, from RAWG (rawg.io/apidocs), fetched at build
 * time the same way scripts/repos.js fetches the repo list.
 *
 * Needs an API key in RAWG_API_KEY. Without one, or if the call fails, `games`
 * comes back empty and the home page simply leaves the section out: a missing
 * key must never fail a deploy.
 *
 * Because this is a static site the list is frozen at build time, so the
 * workflow rebuilds on a daily schedule to keep it current.
 *
 * RAWG's terms require crediting them with a link, which the home page does.
 */

let games = [];

// First and last day of next month, in RAWG's YYYY-MM-DD format. Built from UTC
// parts so a machine in any timezone picks the same month.
function nextMonthRange(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const first = new Date(Date.UTC(y, m + 1, 1));
  const last = new Date(Date.UTC(y, m + 2, 0));
  const iso = d => d.toISOString().slice(0, 10);
  return { from: iso(first), to: iso(last), label: first.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
}

let range = nextMonthRange();

hexo.extend.filter.register('before_generate', async function () {
  const key = process.env.RAWG_API_KEY;
  if (!key) {
    hexo.log.info('games: RAWG_API_KEY not set, skipping the upcoming games section');
    games = [];
    return;
  }

  range = nextMonthRange();
  const url = 'https://api.rawg.io/api/games'
    + `?key=${encodeURIComponent(key)}`
    + `&dates=${range.from},${range.to}`
    + '&ordering=-added&page_size=6';

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // The image URL goes into a style attribute, so anything that is not a
    // plain https URL is dropped rather than escaped: the card simply renders
    // without art.
    const safeImage = u => (typeof u === 'string' && /^https:\/\/[^"'()\s\\]+$/.test(u)) ? u : '';

    games = (data.results || []).map(g => ({
      name: g.name,
      url: `https://rawg.io/games/${encodeURIComponent(g.slug)}`,
      released: g.released || '',
      image: safeImage(g.background_image),
      metacritic: g.metacritic || 0,
      // A game on eight platforms would run off the card; the first three are
      // enough to say what it is.
      platforms: (g.platforms || []).map(p => p.platform.name).slice(0, 3)
    }));

    hexo.log.info(`games: ${games.length} releases for ${range.label} from RAWG`);
  } catch (err) {
    hexo.log.warn(`games: RAWG unreachable (${err.message}); the upcoming games section will be left out`);
    games = [];
  }
});

hexo.locals.set('games', () => ({ list: games, month: range.label }));
