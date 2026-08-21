/**
 * game2048.js —— 2048（Canvas 实现）
 * ---------------------------------------------------------
 * 4x4 网格，滑动手势合并数字方块。核心算法：
 *   对每次滑动方向，把该方向上的每一行/列做"压缩+合并+再压缩"，
 *   逐行/列比较移动前后是否变化以判断这次操作是否有效（无效则不生成新方块）。
 * 分数与最高分持久化到 IndexedDB `game_saves` 表（gameId='2048'）。
 */

import { DB } from '../../core/db.js';

const SIZE = 4;
const COLORS = {
  0: '#3a3a4a',
  2: '#eee4da',
  4: '#ede0c8',
  8: '#f2b179',
  16: '#f59563',
  32: '#f67c5f',
  64: '#f65e3b',
  128: '#edcf72',
  256: '#edcc61',
  512: '#edc850',
  1024: '#edc53f',
  2048: '#edc22e',
};

export async function mount(container) {
  container.innerHTML = `
    <div class="g2048-wrap">
      <div class="g2048-hud"><span class="g2048-score">得分：0</span><span class="g2048-best">最高：0</span></div>
      <canvas class="g2048-canvas"></canvas>
      <div class="g2048-gameover" hidden>
        <div class="g2048-gameover-title">游戏结束</div>
        <button class="btn g2048-restart">重新开始</button>
      </div>
    </div>
  `;
  injectStyles();

  const canvas = container.querySelector('.g2048-canvas');
  const ctx = canvas.getContext('2d');
  const scoreEl = container.querySelector('.g2048-score');
  const bestEl = container.querySelector('.g2048-best');
  const overOverlay = container.querySelector('.g2048-gameover');

  function resize() {
    const wrap = container.querySelector('.g2048-wrap');
    const size = Math.min(wrap.clientWidth, wrap.clientHeight - 50) - 20;
    canvas.width = size;
    canvas.height = size;
    draw();
  }

  let board, score, best;

  async function loadBest() {
    const save = await DB.get('game_saves', '2048');
    best = save ? save.bestScore : 0;
    bestEl.textContent = `最高：${best}`;
  }

  function reset() {
    board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    score = 0;
    scoreEl.textContent = `得分：${score}`;
    overOverlay.hidden = true;
    spawnTile();
    spawnTile();
    draw();
  }

  function spawnTile() {
    const empties = [];
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++) if (board[r][c] === 0) empties.push([r, c]);
    if (empties.length === 0) return;
    const [r, c] = empties[Math.floor(Math.random() * empties.length)];
    board[r][c] = Math.random() < 0.9 ? 2 : 4;
  }

  /** 把一行（已按方向排列好顺序的数组）压缩+合并，返回 {row, gained, moved} */
  function collapseLine(line) {
    const nonZero = line.filter((v) => v !== 0);
    const merged = [];
    let gained = 0;
    for (let i = 0; i < nonZero.length; i++) {
      if (nonZero[i] === nonZero[i + 1]) {
        merged.push(nonZero[i] * 2);
        gained += nonZero[i] * 2;
        i++;
      } else {
        merged.push(nonZero[i]);
      }
    }
    while (merged.length < SIZE) merged.push(0);
    const moved = merged.some((v, i) => v !== line[i]);
    return { row: merged, gained, moved };
  }

  function move(direction) {
    let moved = false;
    let totalGain = 0;

    function getLine(i, dir) {
      const line = [];
      for (let j = 0; j < SIZE; j++) {
        if (dir === 'left') line.push(board[i][j]);
        else if (dir === 'right') line.push(board[i][SIZE - 1 - j]);
        else if (dir === 'up') line.push(board[j][i]);
        else if (dir === 'down') line.push(board[SIZE - 1 - j][i]);
      }
      return line;
    }
    function setLine(i, dir, line) {
      for (let j = 0; j < SIZE; j++) {
        if (dir === 'left') board[i][j] = line[j];
        else if (dir === 'right') board[i][SIZE - 1 - j] = line[j];
        else if (dir === 'up') board[j][i] = line[j];
        else if (dir === 'down') board[SIZE - 1 - j][i] = line[j];
      }
    }

    for (let i = 0; i < SIZE; i++) {
      const line = getLine(i, direction);
      const { row, gained, moved: lineMoved } = collapseLine(line);
      if (lineMoved) moved = true;
      totalGain += gained;
      setLine(i, direction, row);
    }

    if (moved) {
      score += totalGain;
      scoreEl.textContent = `得分：${score}`;
      spawnTile();
      draw();
      checkGameOver();
    }
  }

  function checkGameOver() {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c] === 0) return;
        if (c < SIZE - 1 && board[r][c] === board[r][c + 1]) return;
        if (r < SIZE - 1 && board[r][c] === board[r + 1][c]) return;
      }
    }
    endGame();
  }

  async function endGame() {
    overOverlay.hidden = false;
    if (score > best) {
      best = score;
      await DB.put('game_saves', { gameId: '2048', bestScore: best, state: null, updatedAt: Date.now() });
      bestEl.textContent = `最高：${best}`;
    }
  }

  function draw() {
    const cs = canvas.width / SIZE;
    const gap = cs * 0.08;
    ctx.fillStyle = '#2b2b3a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const val = board[r][c];
        const x = c * cs + gap / 2;
        const y = r * cs + gap / 2;
        const w = cs - gap;
        ctx.fillStyle = COLORS[val] || '#3c3a32';
        roundRect(ctx, x, y, w, w, 8);
        ctx.fill();
        if (val) {
          ctx.fillStyle = val <= 4 ? '#5a5348' : '#fff';
          ctx.font = `bold ${Math.round(w * (val > 512 ? 0.32 : 0.4))}px -apple-system, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(val), x + w / 2, y + w / 2 + 2);
        }
      }
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ================= 手势/键盘控制 =================
  let sx = null,
    sy = null;
  canvas.addEventListener(
    'touchstart',
    (e) => {
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
    },
    { passive: true }
  );
  canvas.addEventListener('touchend', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return; // 太短的滑动忽略
    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
    else move(dy > 0 ? 'down' : 'up');
    sx = sy = null;
  });

  function keyHandler(e) {
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (map[e.key]) move(map[e.key]);
  }
  window.addEventListener('keydown', keyHandler);
  window.addEventListener('resize', resize);

  container.querySelector('.g2048-restart').addEventListener('click', reset);

  await loadBest();
  resize();
  reset();

  return () => {
    window.removeEventListener('keydown', keyHandler);
    window.removeEventListener('resize', resize);
  };
}

function injectStyles() {
  if (document.getElementById('g2048-styles')) return;
  const style = document.createElement('style');
  style.id = 'g2048-styles';
  style.textContent = `
    .g2048-wrap { display:flex; flex-direction:column; align-items:center; height:100%; padding:10px; box-sizing:border-box; }
    .g2048-hud { display:flex; justify-content:space-between; width:100%; max-width:400px; color:#fff; font-size:14px; padding:0 4px 8px; }
    .g2048-canvas { border-radius:12px; touch-action:none; }
    .g2048-gameover { position:absolute; inset:0; background:rgba(0,0,0,.75); display:flex; flex-direction:column;
      align-items:center; justify-content:center; gap:16px; }
    .g2048-gameover-title { color:#fff; font-size:22px; font-weight:700; }
  `;
  document.head.appendChild(style);
}
