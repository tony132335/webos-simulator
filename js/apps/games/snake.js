/**
 * snake.js —— 贪吃蛇（Canvas 实现）
 * ---------------------------------------------------------
 * 移动端交互：屏幕滑动手势控制方向（上下左右滑动），
 * 同时保留桌面端方向键支持（便于调试）。
 * 游戏状态：蛇身数组 + 食物坐标 + 方向向量，用 setInterval 做固定步长的游戏循环。
 * 分数与最高分持久化到 IndexedDB `game_saves` 表（gameId='snake'）。
 */

import { DB } from '../../core/db.js';
import { bindSwipe } from '../../core/gesture.js';

const GRID_SIZE = 18; // 18x18 网格
const TICK_MS = 140;

export async function mount(container) {
  container.innerHTML = `
    <div class="snake-wrap">
      <div class="snake-hud"><span class="snake-score">得分：0</span><span class="snake-best">最高：0</span></div>
      <canvas class="snake-canvas"></canvas>
      <div class="snake-gameover" hidden>
        <div class="snake-gameover-title">游戏结束</div>
        <button class="btn snake-restart">重新开始</button>
      </div>
    </div>
  `;
  injectSnakeStyles();

  const canvas = container.querySelector('.snake-canvas');
  const ctx = canvas.getContext('2d');
  const scoreEl = container.querySelector('.snake-score');
  const bestEl = container.querySelector('.snake-best');
  const overOverlay = container.querySelector('.snake-gameover');

  function resize() {
    const wrap = container.querySelector('.snake-wrap');
    const size = Math.min(wrap.clientWidth, wrap.clientHeight - 50);
    canvas.width = size;
    canvas.height = size;
  }
  resize();
  window.addEventListener('resize', resize);

  let cellSize = () => canvas.width / GRID_SIZE;

  let snake, direction, nextDirection, food, score, best, timer, running;

  async function loadBest() {
    const save = await DB.get('game_saves', 'snake');
    best = save ? save.bestScore : 0;
    bestEl.textContent = `最高：${best}`;
  }

  function randomFood() {
    let pos;
    do {
      pos = { x: Math.floor(Math.random() * GRID_SIZE), y: Math.floor(Math.random() * GRID_SIZE) };
    } while (snake.some((s) => s.x === pos.x && s.y === pos.y));
    return pos;
  }

  function reset() {
    snake = [
      { x: 8, y: 9 },
      { x: 7, y: 9 },
      { x: 6, y: 9 },
    ];
    direction = { x: 1, y: 0 };
    nextDirection = { x: 1, y: 0 };
    food = randomFood();
    score = 0;
    scoreEl.textContent = `得分：${score}`;
    running = true;
    overOverlay.hidden = true;
    if (timer) clearInterval(timer);
    timer = setInterval(tick, TICK_MS);
    draw();
  }

  function tick() {
    if (!running) return;
    direction = nextDirection;
    const head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y };

    if (head.x < 0 || head.y < 0 || head.x >= GRID_SIZE || head.y >= GRID_SIZE || snake.some((s) => s.x === head.x && s.y === head.y)) {
      gameOver();
      return;
    }

    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) {
      score += 10;
      scoreEl.textContent = `得分：${score}`;
      food = randomFood();
    } else {
      snake.pop();
    }
    draw();
  }

  async function gameOver() {
    running = false;
    clearInterval(timer);
    overOverlay.hidden = false;
    if (score > best) {
      best = score;
      await DB.put('game_saves', { gameId: 'snake', bestScore: best, state: null, updatedAt: Date.now() });
      bestEl.textContent = `最高：${best}`;
    }
  }

  function draw() {
    const cs = cellSize();
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 食物
    ctx.fillStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.arc((food.x + 0.5) * cs, (food.y + 0.5) * cs, cs * 0.38, 0, Math.PI * 2);
    ctx.fill();

    // 蛇身
    snake.forEach((seg, i) => {
      ctx.fillStyle = i === 0 ? '#4ecdc4' : `rgba(78,205,196,${Math.max(0.4, 1 - i * 0.03)})`;
      const pad = 1.5;
      ctx.fillRect(seg.x * cs + pad, seg.y * cs + pad, cs - pad * 2, cs - pad * 2);
    });
  }

  // ================= 输入控制 =================
  function setDirection(dx, dy) {
    // 禁止直接反向移动（防止咬自己脖子）
    if (direction.x === -dx && direction.y === -dy) return;
    nextDirection = { x: dx, y: dy };
  }

  bindSwipe(canvas, {
    onSwipeLeft: () => setDirection(-1, 0),
    onSwipeRight: () => setDirection(1, 0),
  });
  // bindSwipe 只处理水平方向，垂直方向单独用 touch 事件实现
  let touchStartY = null,
    touchStartX = null;
  canvas.addEventListener(
    'touchstart',
    (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    },
    { passive: true }
  );
  canvas.addEventListener('touchend', (e) => {
    if (touchStartY === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 30) {
      setDirection(0, dy < 0 ? -1 : 1);
    }
    touchStartX = touchStartY = null;
  });

  function keyHandler(e) {
    const map = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (map[e.key]) setDirection(...map[e.key]);
  }
  window.addEventListener('keydown', keyHandler);

  container.querySelector('.snake-restart').addEventListener('click', reset);

  await loadBest();
  reset();

  return () => {
    clearInterval(timer);
    window.removeEventListener('keydown', keyHandler);
    window.removeEventListener('resize', resize);
  };
}

function injectSnakeStyles() {
  if (document.getElementById('snake-styles')) return;
  const style = document.createElement('style');
  style.id = 'snake-styles';
  style.textContent = `
    .snake-wrap { display:flex; flex-direction:column; align-items:center; height:100%; padding:10px; box-sizing:border-box; }
    .snake-hud { display:flex; justify-content:space-between; width:100%; max-width:400px; color:#fff; font-size:14px; padding:0 4px 8px; }
    .snake-canvas { border-radius:12px; touch-action:none; }
    .snake-gameover { position:absolute; inset:0; background:rgba(0,0,0,.75); display:flex; flex-direction:column;
      align-items:center; justify-content:center; gap:16px; }
    .snake-gameover-title { color:#fff; font-size:22px; font-weight:700; }
  `;
  document.head.appendChild(style);
}
