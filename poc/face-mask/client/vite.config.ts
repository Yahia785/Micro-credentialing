import { defineConfig } from "vite";

// Port 5180: localhost counts as a secure context, so the camera works over plain http.
export default defineConfig({
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
  test: { include: ["tests/**/*.test.ts"] },
});
