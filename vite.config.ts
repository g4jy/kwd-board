import { defineConfig } from 'vite';

// base: './' 로 두면 GitHub Pages·Cloudflare Pages 어느 경로에 올려도 동작한다.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: { host: true, port: 5173 },
});
