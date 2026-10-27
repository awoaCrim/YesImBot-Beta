import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: {
      "koishi-plugin-yesimbot-mcp-client/transports": fileURLToPath(new URL("../mcp-client/src/transports.ts", import.meta.url)),
      "koishi-plugin-yesimbot": fileURLToPath(new URL("../../core/src/index.ts", import.meta.url)),
      "@yesimbot/agent-runtime": fileURLToPath(new URL("../../packages/agent-runtime/src/index.ts", import.meta.url)),
    },
  },
});
