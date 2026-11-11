import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-static';
export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({ fallback: 'index.html' }),
      prerender: { entries: [] },
    }),
  ],
  server: { host: '127.0.0.1', port: 4511, strictPort: true },
});
