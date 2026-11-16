//dev server: the page talks to /relay, /nexus and /evm on its own origin; here they go to the services in the same
//machine (nexus-dev). A deployed site sets the real addresses in config.json instead.
//mode "module" builds the desktop wallet module (module/build.mjs): relative paths and one classic script, since a
//module folder opens from file:// where module scripts do not load
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = (port: number, prefix: string) => ({ target: `http://127.0.0.1:${port}`, changeOrigin: true, rewrite: (p: string) => p.replace(new RegExp(`^/${prefix}`), '') });

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'module' ? './' : '/',
  build:
    mode === 'module'
      ? {
          outDir: process.env.DEX_MODULE_OUT ?? '../module/dist',
          emptyOutDir: true,
          modulePreload: false,
          copyPublicDir: false, //the module's config is config.js from module/build.mjs
          rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } },
        }
      : {},
  server: {
    host: process.env.DEX_HOST ?? '127.0.0.1',
    port: Number(process.env.DEX_PORT ?? 5180),
    strictPort: true,
    fs: { allow: ['..', '../../wallet'] },
    proxy: {
      '/relay': target(3200, 'relay'),
      '/nexus': target(7080, 'nexus'),
      '/evm': target(8545, 'evm'),
      '/keeper': target(3201, 'keeper'),
    },
  },
}));
