# Browser Shell Smoke Checklist

Run this checklist against the Docker development server at
`http://localhost:8080` (`bun run dev`). The nginx routes and shell CSP are not
available in the Vite playground.

- [ ] Root load: open `/`; the shell renders the root catalogue.
- [ ] Deep folder load: bookmark and reload a nested folder URL.
- [ ] Breadcrumbs: breadcrumb links navigate to the expected folders; the page
      title includes the current folder, including a non-ASCII folder name.
- [ ] Popup open: select a book card and confirm its popup opens.
- [ ] Keyboard grid navigation: focus the page, use arrows/WASD to enter and move
      through the card grid, and confirm movement stops at row and grid edges.
- [ ] Popup close with Esc: press `Esc`; the popup closes and the URL hash is
      cleared.
- [ ] Popup close with Back: open a popup, press the browser Back button, and
      confirm the popup closes without leaving the folder.
- [ ] `#book-N` deep link: load a folder URL with a book hash; the matching
      popup opens on page load.
- [ ] View: select View and confirm the reader opens for the selected book.
- [ ] Download: select Download and confirm the file saves with its original
      name.
- [ ] Initializing state with retry: start with an empty `/data`; confirm the
      starting message appears, then confirm the feed renders after retry.
- [ ] Slow network: throttle the feed request above 300 ms; confirm the shell
      stays empty briefly, then shows the header and card skeleton until the
      catalogue renders.
- [ ] Folder prefetch: open a folder with subfolders and confirm the browser
      prefetches their `feed.xml` responses, but not book files or covers.
- [ ] Not-found state: open `/no-such-folder/`; confirm "Folder not found" and
      the home link.
- [ ] Console: confirm there are no CSP violations.
