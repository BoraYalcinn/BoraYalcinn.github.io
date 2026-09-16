# BoraYalcinn.github.io

Personal site — blog, shaders and projects. Built with [Hugo](https://gohugo.io/)
and the [RetroCSS 9x](https://github.com/PhantomPixelDev/hugo-theme-retrocss)
theme, which is vendored as a git submodule.

```bash
git clone --recurse-submodules git@github.com:BoraYalcinn/BoraYalcinn.github.io.git
cd BoraYalcinn.github.io
hugo server --buildDrafts        # http://localhost:1313
```

Already cloned without `--recurse-submodules`? `git submodule update --init`.

See **[AUTHORING.md](AUTHORING.md)** for how to add posts, shaders, projects,
cover images and featured entries.

## Layout

| Path | What it is |
|---|---|
| `content/blog/` | Blog posts; drives the home page feed |
| `content/shaders/` | Shadertoy write-ups, via the `shadertoy` shortcode |
| `content/projects/` | Project write-ups, linked to GitHub repos by `repo:` |
| `content/_index.md` | Home page "about me" text |
| `data/projects.toml` | Featured / hidden / overrides for the repo list |
| `data/reposSnapshot.json` | Offline fallback for the GitHub API |
| `layouts/` | Site overrides on top of the theme |
| `.pages.yml` | [Pages CMS](https://app.pagescms.org) panel config — the browser editor |
| `static/images/` | Images not tied to a single page |
