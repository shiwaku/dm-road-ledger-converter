import { defineConfig } from 'vite'

export default defineConfig({
  // GitHub Pages（/<repo>/ 配下）でもそのまま動くよう相対にする
  base: './',
  server: {
    host: true,
    // dm-converter のビューワ（5174）と同時に立ち上げられるよう別ポートにする
    port: 5175,
    strictPort: true,
    watch: {
      // WSL で /mnt/c 上のファイル変更が inotify に伝わらないため、
      // ポーリングで拾う。これが無いと dev サーバが古いコードを返し続ける。
      usePolling: true,
      interval: 300,
    },
  },
  build: {
    // main.ts が最上位 await で背景スタイルを読むため ES2022 が必要
    target: 'es2022',
    // PMTiles をインライン化させない
    assetsInlineLimit: 0,
  },
  define: {
    __BUILD_TIME__: JSON.stringify(
      new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    ),
  },
})
