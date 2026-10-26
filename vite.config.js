import { defineConfig } from "vite";

// The browser test harness loads sample photos from outside the project via /@fs/,
// so allow the parent folder in dev. Production builds are fully static.
export default defineConfig({
  base: "./",
  server: {
    fs: { allow: [".."] },
  },
});
