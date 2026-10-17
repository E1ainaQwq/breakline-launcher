import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'

/**
 * 这块窗口**只有**主 preload 的窄接口（见 `preload/acanim.ts`）：
 * 拿不到 `window.delta`（没有 launch / config / player 任何一条通道），
 * 所以它被注入也做不了任何事 —— 只能报告"我播到第几秒了"。
 */
declare global {
  interface Window {
    deltaAnim?: { signal: (payload: string) => void }
  }
}

/**
 * 反作弊启动浮层 —— **独立于启动器窗口**的一块屏幕浮层（`acanim.html`）。
 *
 * <h2>形态照运维给的参考图（EAC 那一张）</h2>
 * 参考图是 Easy Anti-Cheat 在游戏里初始化时压在画面角落的那一块：
 * **品牌标记 + "正在初始化 …" + 一条细进度条**，深色半透明底、圆角、无标题栏。
 * 本文件是这个形态的两条路：
 *   · **有视频素材** ⇒ 视频**铺满整块窗口**，文字与读条压在视频上（运维 2026-09-19：
 *     「视频要盖着窗口」）；
 *   · **没素材** ⇒ 同一块尺寸里放品牌标记 + 文字 + 读条，不留空框。
 * 两条路共用同一套文字/读条层，所以不会出现"两套版式各改一半"的漂移。
 * 颜色用断界行动的橙（品牌一致），版式、比例、留白照参考图 —— 它的重点不是"炫"，
 * 而是**一眼看懂"反作弊在起、还没好"**，且不遮挡游戏画面。
 *
 * <h2>为什么必须是独立窗口</h2>
 * 运维 2026-09-19 明确：「要在屏幕右下角播放的」「独立于启动器窗口」。
 * 放在启动器窗口里做不到：启动器可能被最小化、拖到别处、收进托盘，而且玩家点完启动
 * 就会去开别的窗口 —— 那时"右下角"就不再是屏幕的右下角。所以它由主进程
 * `openAcAnimWindow()` 创建：无边框、透明、置顶、**不抢焦点**、鼠标点透。
 *
 * <h2>这块面板**不是**进度显示器</h2>
 * 读条走固定的时间轴（{@link DURATION_MS}），表示的是**等待时间**，不谎报工作量 ——
 * 与游戏内那块 `AcLoadingScreen` 同一条纪律。文案里没有"正在检测 37%"这类伪造进度。
 *
 * <h2>视频素材（可选）</h2>
 * `media` 查询参数由主进程随 `loadFile` 传进来（所以这块窗口不需要任何 IPC 就能拿到视频，
 * 也就不必给它开"读文件"的口子）。有素材时视频占 logo 区左侧一块小画面；
 * 没有素材时**不留空框** —— 直接就是参考图那种纯 logo + 读条的样子。
 */

/**
 * 缩放系数。**必须与主进程的 `AC_ANIM_SCALE` 一致**（那边算窗口大小，这边放大内容）。
 *
 * 为什么要整层 `zoom` 而不是把每个字号改大：这套版式是按 **252 宽**定的基准设计
 * （见文件头与主进程的尺寸注释）。窗口尺寸一动，如果只改窗口、不改字号，
 * 得到的是一块**大空板**；而逐个改字号/内距意味着以后每次动尺寸都要改十几处，迟早漂移。
 * 用 `zoom` ⇒ 只有这一个数与主进程那个数需要对齐。
 */
const SCALE = 1.5

/** 时间轴总长。主进程按 `AC_ANIM_MS` 到点收窗，两边必须一致（见主进程注释）。
 *
 * ⚠️ 不能短于品牌片的时长：素材现在是 **10.17 秒**（MUGEN 品牌片），
 * 面板若比它先收起，片子就会被腰斩在最后一秒 —— 而"被腰斩"看起来像视频卡住了。
 * 反过来片子比时间轴短时靠 `loop` 兜底。
 */
const DURATION_MS = 10400

/** 读条文案 + 各自结束时刻（毫秒）。最后一条停在 100% 等窗口收起。 */
const STEPS = [
  { at: 0, text: '正在初始化 …' },
  { at: 1800, text: '正在校验客户端文件 …' },
  { at: 4600, text: '正在加载 MUGEN AC 组件 …' },
  { at: 8000, text: '启动游戏 …' }
] as const

/** 把主进程传来的 `file://` 素材地址读出来。没有就是"没放素材"，不渲染视频区。 */
function mediaFromQuery(): string | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('media')
    return raw && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

/**
 * 品牌标记。
 *
 * 断界行动的 logo 是一枚带预警三角的盾 —— 这里用**内联 SVG**画一个同构的简化版：
 * 参考图里那个位置是 EasyAntiCheat 的六边形，我们这里放自己的盾牌，
 * 形状（实心盾 + 镂空三角）在 40 px 下也能认出来。
 * 品牌规范（`assets/logo.svg`）里是描边+渐变的全尺寸 logo，缩小到这一档会糊成一块，
 * 所以这里按"同一意象、不同尺寸"重画，而不是硬缩。
 */
function BrandMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="ac-brand" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffa04d" />
          <stop offset="100%" stopColor="#ff7a1a" />
        </linearGradient>
      </defs>
      <path
        d="M24 3 42 10v14.5C42 34.6 34.6 43.4 24 46 13.4 43.4 6 34.6 6 24.5V10z"
        fill="url(#ac-brand)"
      />
      <path
        d="M24 14.5 34 33H14z"
        fill="#0b0d11"
        stroke="#0b0d11"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M24 21.6v5.1M24 30.1h.01" stroke="url(#ac-brand)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  )
}

export default function AcStartupPanel(): React.JSX.Element {
  const [mediaUrl] = useState<string | null>(() => mediaFromQuery())
  const [elapsed, setElapsed] = useState(0)
  /** 有素材但**播不动**（编解码不支持 / file:// 被拒）时置位 ⇒ 把视频区整个撤掉 */
  const [videoBroken, setVideoBroken] = useState(false)
  /** 收起阶段（主进程到点关窗，这里只让最后 300ms 不生硬） */
  const [exiting, setExiting] = useState(false)
  const signal = useRef(0)

  /**
   * 计时用 `performance.now()` 自己算，而不是"每帧累加 16ms"：
   * 游戏 JVM 起来那几秒整机都很忙，累加式计时会**越走越慢**，于是读条与窗口关闭时刻错位。
   */
  useEffect(() => {
    const t0 = performance.now()
    const id = window.setInterval(() => {
      const ms = performance.now() - t0
      setElapsed(ms)
      const s = Math.round(ms / 1000)
      if (s > signal.current) {
        signal.current = s
        // 只报告进度，不申请任何权限（见 preload/acanim.ts：这块窗口只有这一个方法）
        void window.deltaAnim?.signal(`t=${s}s`)
      }
      if (ms >= DURATION_MS - 320) setExiting(true)
    }, 80)
    return () => window.clearInterval(id)
  }, [])

  const pct = Math.min(100, (elapsed / DURATION_MS) * 100)
  const stepText = [...STEPS].reverse().find((s) => elapsed >= s.at)?.text ?? '正在初始化 …'
  const showVideo = mediaUrl !== null && !videoBroken

  return (
    /**
     * 外层占满窗口并按 `SCALE` 等比放大；内层就是 252 宽那套设计。
     * `overflow-hidden` 是必须的：这块窗口是透明的，一旦因为 1 px 误差冒出滚动条会非常刺眼。
     */
    <div className="h-full w-full overflow-hidden" style={{ zoom: SCALE }}>
      {/*
        ⚠️ 这一层**必须是 `absolute inset-0` 铺满**，不能用 flex 的 `items-end` 去"贴底"。
        踩过的坑（2026-09-19 实测）：把视频与信息层都改成绝对定位之后，面板本身变成了
        **没有文档流内容的空盒子**，高度直接塌成 2 px（`panelRect.h=2`）——
        于是窗口在、DOM 在、视频 readyState=4，但屏幕上是**一片空白**，
        而"空白"从外面看和"窗口没合成"一模一样，极难判断。铺满窗口就没有这个问题：
        面板高度由窗口给，视频与提示各自绝对定位在里面。
      */}
      <motion.div
        data-testid="ac-startup-overlay"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: exiting ? 0 : 1, y: exiting ? 6 : 0 }}
        transition={{ duration: exiting ? 0.3 : 0.32, ease: [0.22, 0.61, 0.36, 1] }}
        className="absolute inset-0 overflow-hidden rounded-md border border-white/[0.08] bg-[#0b0d11]/[0.92] shadow-[0_12px_36px_-14px_rgba(0,0,0,0.9)] backdrop-blur-sm"
      >
          {/*
            有素材 ⇒ 视频**铺满整个窗口**（`absolute inset-0` + `object-cover`），
            文字与读条**只压在最下面一条**（运维 2026-09-19：「视频要盖着窗口」，
            随后又提「文本提示有点挡到视频了」⇒ 提示收成一行 + 一条细条，约占窗口高度 1/4）。
            没素材 ⇒ 同一块尺寸里放品牌标记（居左居中），不留空框。
          */}
          {showVideo ? (
            <video
              // 不写 controls、不加交互：它是"状态展示"，不是播放器
              className="absolute inset-0 h-full w-full object-cover"
              src={mediaUrl ?? undefined}
              autoPlay
              muted
              playsInline
              // 循环只为"素材比时间轴短"兜底：窗口收起与视频无关
              loop
              onError={() => setVideoBroken(true)}
            />
          ) : (
            <div
              className="img-placeholder flex h-[62%] w-full items-center gap-2 px-2.5"
              data-testid="ac-startup-fallback"
            >
              <BrandMark className="h-6 w-6 shrink-0" />
              <span className="text-[10px] tracking-wide text-white/50">MUGEN AC</span>
            </div>
          )}

          {/*
            信息层：**钉在底部**，高度只占窗口的 ~1/4（24/96）。
            为什么用 `absolute bottom-0` 而不是文档流里的 flex：浮层高度是主进程给的死值，
            信息层一旦参与文档流，它的行高就会把视频顶掉一块；钉在底部则**视频永远是整窗口**，
            提示只是压在它上面的一条 —— 这正是"视频盖着窗口、提示不挡视频"的做法。
          */}
          <div className="absolute inset-x-0 bottom-0 px-2.5 pb-1.5 pt-4">
            {/*
              底部渐变压暗：**有视频时它决定文字读不读得清**（视频可能是亮的）。
              起手用黑色 75% 并在最底变实，往上很快收干净 —— 宁可文字边缘硬一点，
              也不要把上半块视频压成灰色（那才是"挡到视频"）。
            */}
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute inset-0 bg-gradient-to-t ${
                showVideo ? 'from-black/85 via-black/45 to-transparent' : 'from-black/35 to-transparent'
              }`}
            />
            {/* 一行：左状态 / 右百分比。品牌行只在"没有视频"那一路出现（有视频时它就是多余的遮挡） */}
            <div className="relative flex items-baseline gap-1.5">
              <span
                className={`min-w-0 flex-1 truncate text-[11px] leading-tight ${
                  showVideo ? 'font-medium text-white/90' : 'font-semibold text-white/95'
                }`}
              >
                {stepText}
              </span>
              <span className="shrink-0 font-mono text-[10px] font-bold leading-tight tabular-nums text-delta-accent">
                {Math.round(pct)}%
              </span>
            </div>
            {!showVideo && (
              <div className="relative mt-0.5 truncate text-[9px] leading-tight tracking-wide text-white/45">
                MUGEN AC · Adaptive Anti Ch3at System
              </div>
            )}
            <div className="relative mt-1 h-[2px] w-full bg-white/15" data-testid="ac-startup-track">
              <div
                className="relative h-full bg-gradient-to-r from-delta-accent to-delta-accent-2 transition-[width] duration-100 ease-linear"
                data-testid="ac-startup-bar"
                style={{ width: `${pct}%` }}
              >
                {/* 流光：只表示"在处理"，不表示进度 */}
                <div className="ac-sheen absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent" />
              </div>
            </div>
          </div>
        </motion.div>
    </div>
  )
}
