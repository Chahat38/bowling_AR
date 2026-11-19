import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'copy-static-root-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          if (!fs.existsSync(distDir)) return;

          for (const dirName of ['data', 'assets']) {
            const srcDir = path.resolve(__dirname, dirName);
            const destDir = path.resolve(distDir, dirName);
            if (fs.existsSync(srcDir)) {
              fs.cpSync(srcDir, destDir, {recursive: true, force: true});
            }
          }

          for (const fileName of ['manifest.json', 'vercel.json']) {
            const srcFile = path.resolve(__dirname, fileName);
            const destFile = path.resolve(distDir, fileName);
            if (fs.existsSync(srcFile)) {
              fs.cpSync(srcFile, destFile, {force: true});
            }
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
