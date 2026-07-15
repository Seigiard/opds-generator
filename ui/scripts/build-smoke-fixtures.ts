import { rm } from "node:fs/promises";
import { join } from "node:path";

// Generates the U6 smoke EPUB fixtures deterministically so they are committable and
// license-clean (hand-authored). The complex / malicious-font PDFs are user-supplied
// local files per the plan's fixture assumption — see ui/reader/SMOKE.md.

const fixturesDir = join(import.meta.dir, "..", "playground", "fixtures");

const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <ol>
        <li><a href="chapter1.xhtml">Chapter One</a></li>
        <li><a href="chapter2.xhtml">Chapter Two</a></li>
      </ol>
    </nav>
  </body>
</html>`;

const opf = (title: string, extraManifest = "", extraSpine = "") => `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${title.replace(/\W+/g, "-").toLowerCase()}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    ${extraManifest}
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    ${extraSpine}
  </spine>
</package>`;

const chapter = (heading: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${heading}</title></head>
  <body>
    <h1>${heading}</h1>
    ${body}
  </body>
</html>`;

const lorem = Array.from(
  { length: 40 },
  (_, i) =>
    `<p>Paragraph ${i + 1}. The quick brown fox jumps over the lazy dog, repeatedly, to fill the page and force pagination across multiple screens for the reading-position smoke.</p>`,
).join("\n    ");

type Epub = {
  name: string;
  title: string;
  chapter1: string;
  chapter2Body: string;
  extraManifest?: string;
  extraFiles?: Record<string, string>;
};

const EPUBS: Epub[] = [
  {
    name: "baseline.epub",
    title: "Baseline Smoke Book",
    chapter1: `<p>A plain reflowable chapter. Page through with the arrow keys; the position indicator should advance.</p>\n    ${lorem}`,
    chapter2Body: `<p>Second chapter, reachable from the table of contents.</p>\n    ${lorem}`,
  },
  {
    name: "scripted.epub",
    title: "Scripted EPUB (AE3)",
    chapter1: `
    <p id="probe">If the reader is safe, no script ran and this text is unchanged.</p>
    <script>document.getElementById('probe').textContent = 'SCRIPT EXECUTED — CSP FAILURE'; window.__scriptRan = true; try { fetch('/resync'); } catch (e) {}</script>
    <img src="x" onerror="document.title='ONERROR EXECUTED'"/>
    ${lorem}`,
    chapter2Body: lorem,
  },
  {
    name: "csp-matrix.epub",
    title: "CSP Negative-Content Matrix (AE6)",
    // Every vector below must be blocked with no external request and no same-origin
    // non-book request. Verified via the browser's CSP violation reports / network tab.
    chapter1: `
    <p>Each element below is an attack vector; none may load or execute.</p>
    <object data="https://evil.example/o"></object>
    <embed src="https://evil.example/e"/>
    <img src="https://evil.example/external.png" alt="external img"/>
    <img src="/resync" alt="same-origin resync via img"/>
    <img srcset="/resync 1x" alt="same-origin resync via srcset"/>
    <script src="https://evil.example/x.js"></script>
    <form action="/resync" method="get"><input name="q"/></form>
    <base href="https://evil.example/"/>
    <style>
      @import url("https://evil.example/external.css");
      @import url("/resync");
      @font-face { font-family: exfil; src: url("https://evil.example/font.woff2"); }
      body::after { content: url("https://evil.example/exfil.png"); }
    </style>
    ${lorem}`,
    chapter2Body: lorem,
  },
];

async function zipEpub(epub: Epub): Promise<void> {
  const stage = join(fixturesDir, `.stage-${epub.name}`);
  await rm(stage, { recursive: true, force: true });
  await Bun.write(join(stage, "mimetype"), "application/epub+zip");
  await Bun.write(join(stage, "META-INF", "container.xml"), container);
  await Bun.write(join(stage, "OEBPS", "content.opf"), opf(epub.title, epub.extraManifest ?? ""));
  await Bun.write(join(stage, "OEBPS", "nav.xhtml"), nav);
  await Bun.write(join(stage, "OEBPS", "chapter1.xhtml"), chapter("Chapter One", epub.chapter1));
  await Bun.write(join(stage, "OEBPS", "chapter2.xhtml"), chapter("Chapter Two", epub.chapter2Body));
  for (const [path, content] of Object.entries(epub.extraFiles ?? {})) {
    await Bun.write(join(stage, "OEBPS", path), content);
  }

  const out = join(fixturesDir, epub.name);
  await rm(out, { force: true });
  // EPUB OCF: mimetype stored first, uncompressed; -X strips extra attributes for
  // byte-stable output across machines.
  await Bun.$`cd ${stage} && zip -X0 ${out} mimetype && zip -Xr9D ${out} META-INF OEBPS`.quiet();
  await rm(stage, { recursive: true, force: true });
  console.log(`smoke-fixtures → ${out}`);
}

for (const epub of EPUBS) await zipEpub(epub);
