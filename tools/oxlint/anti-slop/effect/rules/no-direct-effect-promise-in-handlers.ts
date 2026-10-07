import { defineRule, type ESTree } from "@oxlint/plugins";

const FORBIDDEN_PROMISE_BRIDGES = new Set(["promise", "tryPromise"]);

function importedName(specifier: ESTree.ImportSpecifier): string | undefined {
  if (specifier.imported.type === "Identifier") return specifier.imported.name;
  return specifier.imported.value;
}

function calledEffectMember(node: ESTree.CallExpression): string | undefined {
  if (
    node.callee.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.object.type !== "Identifier" ||
    node.callee.property.type !== "Identifier"
  ) {
    return undefined;
  }

  return node.callee.property.name;
}

export const noDirectEffectPromiseInHandlersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Use ownedPromise instead of Effect.promise or Effect.tryPromise inside Effect handlers.",
    },
    messages: {
      directPromiseBridge:
        "Use ownedPromise for Promise crossings in Effect handlers. Effect.{{method}} abandons the Promise on interruption.",
    },
  },
  createOnce(context) {
    const effectNames = new Set<string>();

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "effect") return;

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            effectNames.add(specifier.local.name);
          }
          if (specifier.type === "ImportSpecifier" && importedName(specifier) === "Effect") {
            effectNames.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        const method = calledEffectMember(node);
        if (method === undefined || !FORBIDDEN_PROMISE_BRIDGES.has(method)) return;
        if (node.callee.type !== "MemberExpression" || node.callee.object.type !== "Identifier") return;
        if (!effectNames.has(node.callee.object.name)) return;

        context.report({
          node: node.callee,
          messageId: "directPromiseBridge",
          data: { method },
        });
      },
    };
  },
});
