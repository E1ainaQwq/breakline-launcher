import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

/**
 * 三段构建：main（Node 环境）/ preload（桥）/ renderer（浏览器环境）。
 *
 * 为什么用 electron-vite 而不是手搓 vite + tsc：
 * 这三段的 target、外部依赖处理、开发时热重载规则都不一样，手搓等于把这套规则抄一遍，
 * 而抄错的表现是"能编译但运行时报 require 不存在"，很难查。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // 浮层窗口自己的 preload：只暴露 anim:signal（见该文件注释）
          acanim: resolve(__dirname, 'src/preload/acanim.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@renderer': resolve(__dirname, 'src/renderer') } },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          /**
           * 「反作弊启动中」浮层 —— **第二个渲染入口**。
           *
           * 它是一块**独立窗口**（贴在整个屏幕右下角，不是启动器窗口里的一块）：
           * 启动器可能被最小化、拖走、收进托盘，只有独立窗口才谈得上"屏幕右下角"。
           * 多入口在 electron-vite 里就是多一行 input，产物是 `out/renderer/acanim.html`。
           */
          acanim: resolve(__dirname, 'src/renderer/acanim.html')
        }
      }
    }
  }
})
