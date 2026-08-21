/**
 * games-hub.js —— 小游戏中心入口
 * ---------------------------------------------------------
 * 展示游戏列表卡片（含最高分），点击进入具体游戏（贪吃蛇 / 2048）。
 * 每个游戏是独立模块，导出 mount(container)/unmount 供本 hub 动态挂载/卸载，
 * 这样"游戏中心"本身作为一个 APP 窗口，内部又有自己的轻量路由。
 */

import { DB } from '../../core/db.js';
import * as SnakeGame from './snake.js';
import * as Game2048 from './game2048.js';

const GAMES = [
  { id: 'snake', name: '贪吃蛇', icon: '🐍', mod: SnakeGame, desc: '经典像素贪吃蛇，吃食物变长' },
  { id: '2048', name: '2048', icon: '🔢', mod: Game2048, desc: '合并数字方块，挑战 2048' },
];

export async function mount(container, ctx) {
  injectHubStyles();

  container.innerHTML = `
    <div class="app-root gh-root">
      <div class="toolbar"><span class="toolbar-title">游戏中心</span></div>
      <div class="gh-grid"></div>
    </div>
    <div class="gh-game-stage" hidden></div>
  `;

  const grid = container.querySelector('.gh-grid');
  const stage = container.querySelector('.gh-game-stage');
  let activeCleanup = null;

  async function renderGrid() {
    grid.innerHTML = '';
    for (const g of GAMES) {
      const save = await DB.get('game_saves', g.id);
      const best = save ? save.bestScore : 0;
      const card = document.createElement('div');
      card.className = 'gh-card';
      card.innerHTML = `
        <div class="gh-card-icon">${g.icon}</div>
        <div class="gh-card-name">${g.name}</div>
        <div class="gh-card-desc">${g.desc}</div>
        <div class="gh-card-best">最高分：${best}</div>
      `;
      card.addEventListener('click', () => openGame(g));
      grid.appendChild(card);
    }
  }

  async function openGame(g) {
    stage.hidden = false;
    stage.innerHTML = `
      <div class="gh-stage-topbar">
        <button class="icon-btn gh-back">‹</button>
        <span class="toolbar-title">${g.name}</span>
        <span style="width:36px"></span>
      </div>
      <div class="gh-stage-body"></div>
    `;
    const body = stage.querySelector('.gh-stage-body');
    stage.querySelector('.gh-back').addEventListener('click', () => closeGame());
    activeCleanup = await g.mod.mount(body);
  }

  function closeGame() {
    if (activeCleanup) activeCleanup();
    activeCleanup = null;
    stage.hidden = true;
    renderGrid(); // 刷新最高分
  }

  await renderGrid();

  return () => {
    if (activeCleanup) activeCleanup();
  };
}

function injectHubStyles() {
  if (document.getElementById('games-hub-styles')) return;
  const style = document.createElement('style');
  style.id = 'games-hub-styles';
  style.textContent = `
    .gh-root { display:flex; flex-direction:column; height:100%; }
    .gh-grid { flex:1; overflow-y:auto; display:grid; grid-template-columns: 1fr 1fr; gap:12px; padding:14px; }
    .gh-card { background:#fff; border-radius:16px; padding:16px; text-align:center; box-shadow:0 2px 8px rgba(0,0,0,.06); }
    .gh-card-icon { font-size:38px; }
    .gh-card-name { font-size:15px; font-weight:700; margin-top:6px; }
    .gh-card-desc { font-size:11px; color:#999; margin-top:4px; height:28px; }
    .gh-card-best { font-size:12px; color:#0a84ff; margin-top:8px; font-weight:600; }
    .gh-game-stage { position:absolute; inset:0; background:#1c1c1e; z-index:16; display:flex; flex-direction:column; }
    .gh-stage-topbar { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:#111; }
    .gh-stage-topbar .icon-btn, .gh-stage-topbar .toolbar-title { color:#fff; }
    .gh-stage-body { flex:1; position:relative; overflow:hidden; min-height:0; }
  `;
  document.head.appendChild(style);
}
