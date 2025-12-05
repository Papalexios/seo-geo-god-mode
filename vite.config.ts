import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      resolve: {
        alias: {
          buffer: 'buffer/', // Trailing slash forces lookup in node_modules
        },
      },
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || '')
      },
      build: {
        outDir: 'dist',
        target: 'esnext',
        rollupOptions: {
          external: ['mermaid'],
          onwarn(warning, warn) {
            if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
            if (warning.code === 'UNRESOLVED_IMPORT' && warning.message.includes('mermaid')) return;
            warn(warning);
          }
        }
      },
      optimizeDeps: {
        include: ['mermaid']
      }
    };
});