import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiOrigin = 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'web-dist' },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, incoming) => {
            const host = incoming.headers.host;
            // Preserve rejection of cross-origin requests while forwarding the dev UI's own origin.
            if (host && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host) && incoming.headers.origin === 'http://' + host) {
              outgoing.setHeader('origin', apiOrigin);
            }
          });
        },
      },
    },
  },
});
