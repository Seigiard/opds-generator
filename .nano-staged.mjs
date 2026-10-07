import { relative } from "node:path";

// oxfmt honours .prettierignore only when it walks the tree; paths passed explicitly are always
// formatted. Keep these in step with the directory entries in .prettierignore.
const UNFORMATTED = ["/static/", "/ui/vendor/", "/test/golden/", "/tools/oxlint/anti-slop/"];

export default {
  "*": ({ filenames }) => {
    // nano-staged passes absolute paths; match from the repository root so an ancestor directory cannot match.
    const own = filenames.filter((file) => !UNFORMATTED.some((dir) => `/${relative(process.cwd(), file)}`.includes(dir)));

    return own.length === 0 ? [] : `oxfmt --write --no-error-on-unmatched-pattern ${own.map((file) => JSON.stringify(file)).join(" ")}`;
  },
  "*.{ts,js,mjs}": "oxlint --fix --deny-warnings",
  "*.ts": () => "bun --bun tsc --noEmit",
};
