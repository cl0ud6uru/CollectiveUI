import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Model providers are created in one place (src/lib/llm/providers) so credentials, env-fallback blocking,
// billing attribution and policy checks can't be bypassed. Everything else goes through resolveModel().
// ESLint doesn't see dynamic import(), so tests/unit/policy-guards.test.ts backs this up with a text scan.
const PROVIDER_PACKAGES = [
  "@ai-sdk/openai",
  "@ai-sdk/openai/*",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/anthropic",
  "@ai-sdk/anthropic/*",
  "@ai-sdk/azure",
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/amazon-bedrock/*",
  "@ai-sdk/google-vertex",
  "@ai-sdk/google-vertex/*",
  "@ai-sdk/google",
  "@ai-sdk/gateway",
  "@ai-sdk/deepseek",
  "aws4fetch",
  "google-auth-library",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/llm/providers/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: PROVIDER_PACKAGES,
              message: "Create models with resolveModel() from @/lib/llm instead of importing a provider directly.",
            },
          ],
        },
      ],
    },
  },
  // sandboxd holds docker.sock and runs on plain Node (type stripping): no npm packages, no portal modules (never the
  // database, keys or settings), and only TypeScript that erases cleanly. tests/unit/policy-guards.test.ts backs this up.
  {
    files: ["src/sandboxd/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!node:|\\.{1,2}/)",
              message: "sandboxd may only import node:* built-ins and its own files (relative, with a .ts extension).",
            },
          ],
        },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/parameter-properties": ["error", { prefer: "class-property" }],
      "no-restricted-syntax": [
        "error",
        { selector: "TSEnumDeclaration", message: "Enums don't survive Node type stripping." },
        { selector: "TSModuleDeclaration", message: "Namespaces don't survive Node type stripping." },
        { selector: "TSImportEqualsDeclaration", message: "import = doesn't survive Node type stripping." },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
