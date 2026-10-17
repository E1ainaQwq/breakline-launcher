import React from 'react'
import { createRoot } from 'react-dom/client'
import AcStartupPanel from './AcStartupPanel'
import './styles/index.css'

/**
 * 「反作弊启动中」浮层的入口 —— **独立于启动器界面的第二个渲染入口**。
 *
 * 为什么单独一个 entry 而不是复用 `main.tsx`：
 *   ① 这块窗口只渲染一个面板，不该把首页/公告/登录那一整套东西加载进来
 *      （体积、启动时间、以及"两处都在订阅 launch:log"这种没必要的耦合）；
 *   ② 它的窗口是**不抢焦点**的浮层，里面的组件不该有机会弹输入框、做导航。
 */
const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <AcStartupPanel />
    </React.StrictMode>
  )
}
