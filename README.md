# BoraYalcinn.github.io

Personal site — blog, shaders and projects. Built with [Hexo](https://hexo.io/)
and a vendored copy of the
[Aero](https://github.com/5h1nnN/hexo-theme-aero) theme, under `themes/aero`.

```bash
npm install
npm run build:css     # compiles the theme's Sass; rerun after editing any .scss
npx hexo server       # http://localhost:4000
```

GitHub Actions builds and deploys on every push to `main`, and again nightly so
that the two things fetched at build time stay current: the repo list on
`/projects/` (GitHub API, falling back to `source/_data/reposSnapshot.json`) and
the upcoming games on the home page (RAWG, left out entirely unless the
`RAWG_API_KEY` secret is set).

Content lives in `source/`: posts in `_posts/`, project and shader write-ups as
their own folders, and `_data/projects.yml` for the manual layer over the GitHub
repo list. Pages CMS reads `.pages.yml` and commits straight to `main`.
