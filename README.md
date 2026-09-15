# Wiki Rabbit Hole 🕳️

**Live:** https://wiki-rabbit-hole.pages.dev

An interactive Wikipedia explorer. Articles become nodes in a force-directed
graph — click any node to spider outward through its links and watch your
rabbit hole grow, with your full trail mapped along the bottom.

## Run it

No build step, no backend, no API keys. Serve the folder as a static site:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open http://localhost:8000 (or 3000). Deploy free on Cloudflare Pages,
GitHub Pages, Netlify, or Vercel.

## How it works

- 100% client-side vanilla JS + canvas
- Live data from the public Wikipedia API (`api.php` with `origin=*`)
- Force-directed layout: drag nodes, scroll to zoom, drag background to pan
- Click a node to expand its outgoing links (up to 12 new nodes per dig)
- Side panel shows the article summary + thumbnail; breadcrumb trail tracks
  your exact path; dead-end and failed branches are handled gracefully

## Controls

| Action | Result |
|---|---|
| Click node | Focus + expand its links (tap again to retry a failed branch) |
| Drag node | Rearrange the graph |
| Scroll / pinch | Zoom |
| Drag background | Pan |
| `/` | Focus search |
| 🎲 Random | Jump to a random article |

## Notes

- Wikipedia's API is free for reasonable use. The app sends only your search
  terms and the titles of articles you open — nothing else leaves the browser.
- Graph auto-prunes old leaf nodes past 150 to stay smooth.

