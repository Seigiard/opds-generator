export default {
  "*": "oxfmt --write --no-error-on-unmatched-pattern",
  "*.{ts,js,mjs}": "oxlint --fix --deny-warnings",
  "*.ts": () => "bun --bun tsc --noEmit",
};
