import { eslintCompatPlugin } from "@oxlint/plugins";

import { noDirectEffectPromiseRule } from "./rules/no-direct-effect-promise.ts";

/** Rules owned by this repository. The vendored anti-slop plugins stay byte-identical to upstream. */
const opdsPlugin = eslintCompatPlugin({
  meta: { name: "opds" },
  rules: {
    "no-direct-effect-promise": noDirectEffectPromiseRule,
  },
});

export default opdsPlugin;
