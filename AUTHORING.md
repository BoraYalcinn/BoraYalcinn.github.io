# Authoring guide

How to add things to this site. Everything below is verified against the actual
layouts in `layouts/` and the RetroCSS 9x theme in `themes/retrocss/`.

## Two ways to write

**In the browser (no install):** [Pages CMS](https://app.pagescms.org) — sign in
with GitHub, pick this repo, and you get form fields for title/date/categories,
a rich-text editor for the body, and drag-and-drop image upload. Saving commits
straight to the repo. The panel is configured by `.pages.yml`; every field there
maps to a front-matter key the layouts actually read.

**Locally:** the rest of this file. Markdown files in `content/`, previewed with
`hugo server`. Nothing here is HTML — a post is Markdown plus the `---` block at
the top.

The two are interchangeable: the CMS writes the same files, so you can start a
post in the browser and finish it locally, or the other way round.

## Running it locally

```bash
hugo server --buildDrafts     # http://localhost:1313
```

`--buildDrafts` includes posts with `draft: true`. Without it, drafts are
invisible — which is also what happens on the published site.

Do **not** run a plain `hugo` build while the server is running. The server
serves `public/`, and a separate build overwrites it with production output
whose asset filenames the server is not expecting; the page then loads with no
CSS. If that happens: stop the server, `rm -rf public resources`, start again.

## Adding a blog post

```bash
hugo new blog/my-post.md
```

That uses `archetypes/blog.md`, so the front matter comes out pre-filled:

```yaml
---
title: "My Post"
date: 2026-09-16T10:04:00+02:00
draft: true                  # remove or set false to publish
description: ""              # one line; shown on cards and in search results
categories: []               # Dev, Photography, Life, Cinema, Video Games
tags: []
# cover: ""
---
```

- `categories` drives the coloured badge on the card. Stick to the five above
  unless you want a new one — each distinct value gets its own taxonomy page.
- `description` is what the card and the `<meta>` description show. If omitted,
  the theme truncates the body instead, which usually reads worse.
- `featured: true` promotes one post to the big card at the top of the home
  page. Only the newest one with that flag is used.

Posts appear on the home page and under `/blog/` automatically — that comes from
`mainSections = ["blog"]` in `hugo.toml`.

## Adding a shader

```bash
hugo new shaders/my-shader.md
```

Fill in one front-matter field:

```yaml
shaderId: "3l23Rh"      # last path segment of shadertoy.com/view/3l23Rh
shaderPaused: false     # optional
```

The embed is rendered above your text automatically — nothing to type in the
body. In the CMS this is just a text box labelled "Shadertoy ID".

To place a *second* shader mid-article, the shortcode is still there:

```
{{< shadertoy id="XXXXXX" title="Something else" >}}
```

### Why it is a poster, not a live embed

Shadertoy sits behind Cloudflare. A cross-origin iframe reaches it without
Shadertoy's cookies — Chrome blocks third-party cookies by default — so
Cloudflare answers with a bot challenge, and that challenge page refuses to be
framed. The visitor gets "refused to connect" in a grey box. Opening the same
embed URL in a tab works, which is what makes the poster a fair substitute: a
still of the shader that opens the working page in one click.

So the page shows a 16:9 poster with a play button. Give the shader a `cover`
and that image fills it; without one it falls back to a dark panel showing the
shader id. Either way the caption links to Shadertoy.

To try the live embed on a page anyway, set `shaderEmbed: true` ("Try the live
embed" in the CMS).

Shaders live in their own section and deliberately do **not** appear in the home
page feed.

## Adding a project

Two separate things, and you can do either without the other.

### 1. The repo list (automatic)

`/projects/` fetches every public repo from the GitHub API at build time. A new
repo shows up on the next build with no work from you.

Control it in `data/projects.toml`:

```toml
featured  = ["CezveRender"]     # big cards at the top, in this order
hidden    = ["BoraYalcinn"]     # never listed
showForks = ["godot"]           # forks are hidden unless named here

[[overrides]]
  repo        = "CezveRender"   # required; matches the GitHub repo name
  title       = "CezveRender"
  description = "Overrides whatever GitHub reports."
  cover       = "/images/projects/cezverender.png"
```

`overrides` is a list rather than a keyed table so that every key is declared in
`.pages.yml` — the CMS then rewrites the file without dropping anything it was
not told about.

To feature one more project, add its repo name to `featured`. That is the whole
step — the card moves to the top and out of the long list below.

If the GitHub API is unreachable at build time (it is rate-limited to 60
requests/hour per IP unauthenticated, and CI runners share addresses), the page
falls back to `data/reposSnapshot.json` and prints a small note. Refresh that
snapshot with:

```bash
curl -s "https://api.github.com/users/BoraYalcinn/repos?per_page=100&sort=updated" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);k=['name','description','html_url','language','stargazers_count','fork','archived','updated_at','homepage'];json.dump([{x:r.get(x) for x in k} for r in d],open('data/reposSnapshot.json','w'),indent=1,ensure_ascii=False)"
```

Set `HUGO_GITHUB_TOKEN` in CI to raise the rate limit and keep the live path.

### 2. The write-up page (optional)

```bash
hugo new projects/cezverender.md
```

The one field that matters:

```yaml
repo: "CezveRender"     # must match the GitHub repo name exactly
```

That links the page to the repo. The card on `/projects/` gains a **Read more**
button pointing at the page, and the page header pulls language, star count and
the GitHub link live from the API — so you never retype them and they cannot
drift out of date.

A project page without `repo:` still works; it just shows up under
"Write-ups" instead of being attached to a repo card.

## Images

### Cover images

Two ways. Both are wired into cards, the article hero, and the OpenGraph
`og:image` used when a link is shared.

**A. Page bundle** — best when the images belong to one post.

```
content/blog/my-post/
├── index.md          ← note: index.md, not my-post.md
├── cover.png         ← picked up automatically, no front matter needed
└── diagram.png
```

Any file named `cover.*`, `feature.*` or `thumbnail.*` becomes the cover.

**B. Shared folder** — best for images reused across pages.

```
static/images/blog/my-shot.jpg
```

```yaml
cover: "/images/blog/my-shot.jpg"
```

Paths under `static/` are served from the site root, so `static/images/foo.png`
is `/images/foo.png`. Folders for `blog/`, `projects/` and `shaders/` already
exist.

Precedence, if more than one is present: bundle resource → `cover:` → `images[0]`.

### Images inside a page

In a page bundle, reference the file by name:

```markdown
![Alt text](diagram.png)
![Alt text](diagram.png "A caption under the image")
```

From `static/`, use an absolute path:

```markdown
![Alt text](/images/blog/my-shot.jpg)
```

The theme's render hook adds `width`/`height`/`loading="lazy"` automatically for
bundle images, so the page does not reflow while they decode. A title in quotes
becomes a `<figcaption>`.

Alt text is what a screen reader announces — describe the image, or leave it
empty (`![](x.png)`) if it is purely decorative.

### Video

Shadertoy embeds have their own shortcode. For anything else, plain HTML works
because `markup.goldmark.renderer.unsafe = true` is set:

```html
<video controls width="100%" src="/images/projects/demo.mp4"></video>
```

## The home page "about me"

Edit `content/_index.md`. Everything under the front matter renders on the home
page, between the site description and the post feed.

## Social links

`hugo.toml`, the `[[params.social]]` blocks. Each needs `name`, `url` and an
`icon` that exists in the icon table inside
`layouts/partials/social-links.html`. Currently available: `github`, `linkedin`,
`youtube`, `behance`, `steam`. Adding a network means adding its SVG path there
too — the marks come from Simple Icons (CC0), on a 24×24 viewBox.

The Behance URL is still the placeholder `https://www.behance.net/USERNAME`.

## Comments

giscus, configured under `[params.comments.giscus]` in `hugo.toml`, backed by
GitHub Discussions in the **Comments** category. Comments appear on blog posts,
shader pages and project pages — not on listing pages.

`mapping = "pathname"` means the discussion key is the page path, so a comment
left on `localhost` lands on the same discussion as the published page.

To turn comments off for one page: `comments: false` in its front matter.

## Themes

The site opens in light mode regardless of the visitor's OS setting; the nav
toggle switches it and the choice persists. This is deliberate and lives in
`layouts/partials/head/theme-init.html` — see the comment there before changing
it, because the attribute and `localStorage` have to agree or a dark-OS visitor
gets a flash.

## Publishing

```bash
hugo                    # builds to public/
```

The repo is public and GitHub Pages serves from it. Drafts stay out of a plain
build, so an unfinished post is safe to commit.
