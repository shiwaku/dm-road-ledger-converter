import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages（/<repo>/ 配下）でもそのまま動くよう相対にする
  base: './',
  server: {
    host: true,
    watch: {
      // WSL で /mnt/c 上のファイル変更が inotify に伝わらないため、
      // ポーリングで拾う。これが無いと dev サーバが古いコードを返し続ける。
      usePolling: true,
      interval: 300,
    },
  },
  build: {
    // PMTiles をインライン化させない
    assetsInlineLimit: 0,
  },
});
