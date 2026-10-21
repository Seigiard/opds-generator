---
status: accepted
---

# The browser view is a single-page application over feed.xml

The generator used to render `index.html` next to every `feed.xml`, so a change to the browser view's markup or styles meant bumping the folder processing version and rebuilding every folder in the catalogue. We decided that the generator writes data only: `feed.xml`, `_entry.xml`, covers and the `file` link. The browser view is one static shell in `static/`, served by nginx for every folder path, which fetches the folder's `feed.xml`, parses it with the browser's `DOMParser` into the same `FeedModel` the renderer already uses, and renders it with `renderHtml`. OPDS readers keep reading the same `feed.xml`; the feed is the one contract between the generator and the browser view.

Served paths are split by prefix, as in TTRPG Map Viewer: `/_app/` for the shell, its assets and the reader, `/_catalog/` for the output tree, `/opds` for the OPDS root entry. Every other path is a folder path that serves the shell. Breadcrumbs come from the URL path segments, because a folder feed's title is the folder name. **Minimum** is the root feed alone.

## Considered Options

- **Keep server-rendered `index.html`**: rejected, because every change to the view is a full catalogue rebuild, and the generated page duplicates data the feed already carries.
- **A second `index.json` per folder for the browser**: rejected, because it adds a second contract to keep in step with the feed for no gain at catalogue sizes under a thousand entries per folder.
- **Bundle `fast-xml-parser` into the browser**: rejected, because its minified parser is ten times the size of the whole viewer script, and `DOMParser` is native. The server-side `parseFeed` stays for tests and tooling; both parsers target the same `FeedModel` and the same feed fixtures.
- **Breadcrumbs from `rel="up"` links**: rejected for now, because it costs one request per level. Revisit if folder titles ever stop equalling folder names.

## Consequences

- The browser view needs JavaScript. A `<noscript>` link points at the root OPDS feed (`/opds`).
- A markup or style change ships with `static/` and needs no processing-version bump. Changing the feed's link scheme or content still does.
- Book metadata reaches the page through `innerHTML`, so escaping in `renderHtml` stays the first line of defence and a Content-Security-Policy header on the shell is the second.
- `renderHtml` returns a body fragment; the shell owns `<head>`. Golden files pin the fragment.
- Per-folder search and sort are pure functions over `FeedModel` when they come. Global search needs a generator-produced index and its own ADR.
