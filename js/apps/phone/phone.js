/**
 * phone.js —— 电话 APP（模拟器，无真实通信能力）
 * ---------------------------------------------------------
 * 功能：
 *   - 底部三个 Tab：拨号盘 / 通讯录 / 通话记录
 *   - 拨号盘：数字输入、退格（长按清空）、拨打
 *   - 通话界面：拨号中 → 接通计时 → 挂断，含逼真的状态切换动画
 *   - 通讯录：增删改查，数据存 IndexedDB `contacts` 表
 *   - 通话记录：自动生成，存 `call_logs` 表，可从记录直接回拨
 */

import { DB, uuid } from '../../core/db.js';

const AVATAR_COLORS = ['#FF6B6B', '#4ECDC4', '#FFD93D', '#6C5CE7', '#00B894', '#FD79A8', '#0984E3', '#E17055'];

export async function mount(container, ctx) {
  injectPhoneStyles();

  container.innerHTML = `
    <div class="app-root ph-root">
      <div class="ph-pages">
        <div class="ph-page ph-page-dial"></div>
        <div class="ph-page ph-page-contacts" hidden></div>
        <div class="ph-page ph-page-recents" hidden></div>
      </div>
      <div class="tabbar">
        <div class="tabbar-item active" data-tab="dial"><span class="tabbar-item-icon">🔢</span>拨号</div>
        <div class="tabbar-item" data-tab="contacts"><span class="tabbar-item-icon">👤</span>通讯录</div>
        <div class="tabbar-item" data-tab="recents"><span class="tabbar-item-icon">🕘</span>通话记录</div>
      </div>
    </div>
    <div class="ph-call-overlay" hidden></div>
  `;

  const pages = {
    dial: container.querySelector('.ph-page-dial'),
    contacts: container.querySelector('.ph-page-contacts'),
    recents: container.querySelector('.ph-page-recents'),
  };
  const tabs = container.querySelectorAll('.tabbar-item');
  const callOverlay = container.querySelector('.ph-call-overlay');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      Object.entries(pages).forEach(([key, el]) => (el.hidden = key !== tab.dataset.tab));
      if (tab.dataset.tab === 'contacts') renderContacts();
      if (tab.dataset.tab === 'recents') renderRecents();
    });
  });

  // ================= 拨号盘 =================
  function renderDialPad() {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
    const subLabels = { '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL', '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ', '0': '+' };
    pages.dial.innerHTML = `
      <div class="ph-display">
        <input type="text" class="ph-number-input" readonly />
      </div>
      <div class="ph-keypad">
        ${keys
          .map(
            (k) => `<button class="ph-key" data-key="${k}"><span class="ph-key-num">${k}</span>${
              subLabels[k] ? `<span class="ph-key-sub">${subLabels[k]}</span>` : ''
            }</button>`
          )
          .join('')}
      </div>
      <div class="ph-call-row">
        <div class="ph-call-row-spacer"></div>
        <button class="ph-call-btn">📞</button>
        <button class="ph-backspace" disabled>⌫</button>
      </div>
    `;
    const input = pages.dial.querySelector('.ph-number-input');
    const backspaceBtn = pages.dial.querySelector('.ph-backspace');

    pages.dial.querySelectorAll('.ph-key').forEach((btn) => {
      btn.addEventListener('click', () => {
        input.value += btn.dataset.key;
        backspaceBtn.disabled = input.value.length === 0;
        if (navigator.vibrate) navigator.vibrate(8);
      });
    });

    let bsTimer = null;
    backspaceBtn.addEventListener('click', () => {
      input.value = input.value.slice(0, -1);
      backspaceBtn.disabled = input.value.length === 0;
    });
    backspaceBtn.addEventListener('touchstart', () => {
      bsTimer = setTimeout(() => {
        input.value = '';
        backspaceBtn.disabled = true;
      }, 600);
    });
    backspaceBtn.addEventListener('touchend', () => clearTimeout(bsTimer));

    pages.dial.querySelector('.ph-call-btn').addEventListener('click', () => {
      if (!input.value) return;
      startCall(input.value, null);
    });
  }

  // ================= 通话状态机 =================
  async function startCall(number, contact) {
    callOverlay.hidden = false;
    const startTime = Date.now();
    let seconds = 0;
    let timerHandle = null;
    let phase = 'dialing';

    function render() {
      const name = contact ? contact.name : number;
      const color = contact ? contact.avatarColor : '#8e8e93';
      callOverlay.innerHTML = `
        <div class="ph-call-avatar" style="background:${color}">${name.slice(0, 1)}</div>
        <div class="ph-call-name">${escapeHtml(name)}</div>
        <div class="ph-call-status">${phase === 'dialing' ? '正在拨号…' : phase === 'connected' ? formatDuration(seconds) : '通话结束'}</div>
        <div class="ph-call-actions">
          <button class="ph-call-action-btn ph-mute">🔇<span>静音</span></button>
          <button class="ph-call-action-btn ph-keypad-toggle">⌨️<span>拨号盘</span></button>
          <button class="ph-call-action-btn ph-speaker">🔊<span>免提</span></button>
        </div>
        <button class="ph-hangup">📴</button>
      `;
      callOverlay.querySelector('.ph-hangup').addEventListener('click', hangup);
      callOverlay.querySelectorAll('.ph-call-action-btn').forEach((b) =>
        b.addEventListener('click', () => b.classList.toggle('active'))
      );
    }

    render();

    // 模拟 1.5~2.5s 后"接通"
    const dialDelay = 1500 + Math.random() * 1000;
    const connectTimer = setTimeout(() => {
      phase = 'connected';
      render();
      timerHandle = setInterval(() => {
        seconds++;
        render();
      }, 1000);
    }, dialDelay);

    async function hangup() {
      clearTimeout(connectTimer);
      if (timerHandle) clearInterval(timerHandle);
      const duration = phase === 'connected' ? seconds : 0;
      phase = 'ended';
      render();

      await DB.add('call_logs', {
        id: uuid(),
        contactId: contact ? contact.id : null,
        number,
        type: duration > 0 ? 'outgoing' : 'missed',
        duration,
        timestamp: startTime,
      });

      setTimeout(() => {
        callOverlay.hidden = true;
      }, 700);
    }
  }

  function formatDuration(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  // ================= 通讯录 =================
  async function renderContacts() {
    const contacts = (await DB.getAllByIndex('contacts', 'by_name')).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    pages.contacts.innerHTML = `
      <div class="toolbar">
        <span class="toolbar-title">通讯录</span>
        <button class="icon-btn ph-add-contact">＋</button>
      </div>
      <div class="ph-contact-list list">
        ${
          contacts.length
            ? contacts
                .map(
                  (c) => `
          <div class="list-item ph-contact-item" data-id="${c.id}">
            <div class="ph-avatar" style="background:${c.avatarColor}">${c.name.slice(0, 1)}</div>
            <div class="ph-contact-info"><div class="ph-contact-name">${escapeHtml(c.name)}</div><div class="ph-contact-phone">${escapeHtml(c.phone)}</div></div>
            <button class="ph-contact-call">📞</button>
          </div>`
                )
                .join('')
            : `<div class="empty-state"><div class="empty-state-icon">👤</div><div>还没有联系人</div></div>`
        }
      </div>
    `;

    pages.contacts.querySelector('.ph-add-contact').addEventListener('click', () => openContactForm());
    pages.contacts.querySelectorAll('.ph-contact-item').forEach((item) => {
      const id = item.dataset.id;
      const c = contacts.find((x) => x.id === id);
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('ph-contact-call')) return;
        openContactForm(c);
      });
      item.querySelector('.ph-contact-call').addEventListener('click', (e) => {
        e.stopPropagation();
        startCall(c.phone, c);
      });
    });
  }

  function openContactForm(existing) {
    const modal = document.createElement('div');
    modal.className = 'ph-modal';
    modal.innerHTML = `
      <div class="ph-modal-card">
        <div class="ph-modal-title">${existing ? '编辑联系人' : '新建联系人'}</div>
        <div class="field"><label>姓名</label><input type="text" class="ph-form-name" value="${existing ? escapeAttr(existing.name) : ''}" /></div>
        <div class="field"><label>号码</label><input type="tel" class="ph-form-phone" value="${existing ? escapeAttr(existing.phone) : ''}" /></div>
        <div class="ph-modal-actions">
          ${existing ? '<button class="btn btn-danger ph-form-delete">删除</button>' : '<span></span>'}
          <div>
            <button class="btn btn-secondary ph-form-cancel">取消</button>
            <button class="btn ph-form-save">保存</button>
          </div>
        </div>
      </div>
    `;
    container.appendChild(modal);

    modal.querySelector('.ph-form-cancel').addEventListener('click', () => modal.remove());
    modal.querySelector('.ph-form-save').addEventListener('click', async () => {
      const name = modal.querySelector('.ph-form-name').value.trim();
      const phone = modal.querySelector('.ph-form-phone').value.trim();
      if (!name || !phone) {
        alert('姓名和号码均不能为空');
        return;
      }
      const record = existing || {
        id: uuid(),
        avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
        createdAt: Date.now(),
      };
      record.name = name;
      record.phone = phone;
      await DB.put('contacts', record);
      modal.remove();
      renderContacts();
    });
    if (existing) {
      modal.querySelector('.ph-form-delete').addEventListener('click', async () => {
        if (!confirm('确定删除该联系人？')) return;
        await DB.delete('contacts', existing.id);
        modal.remove();
        renderContacts();
      });
    }
  }

  // ================= 通话记录 =================
  async function renderRecents() {
    const logs = (await DB.getAllByIndex('call_logs', 'by_timestamp')).sort((a, b) => b.timestamp - a.timestamp);
    pages.recents.innerHTML = `
      <div class="toolbar"><span class="toolbar-title">通话记录</span></div>
      <div class="list">
        ${
          logs.length
            ? logs
                .map(
                  (l) => `
          <div class="list-item ph-recent-item" data-number="${escapeAttr(l.number)}">
            <span class="ph-recent-type">${l.type === 'missed' ? '📵' : '📞'}</span>
            <div class="ph-contact-info">
              <div class="ph-contact-name">${escapeHtml(l.number)}</div>
              <div class="ph-contact-phone">${new Date(l.timestamp).toLocaleString()} · ${l.type === 'missed' ? '未接通' : formatDuration(l.duration)}</div>
            </div>
          </div>`
                )
                .join('')
            : `<div class="empty-state"><div class="empty-state-icon">🕘</div><div>暂无通话记录</div></div>`
        }
      </div>
    `;
    pages.recents.querySelectorAll('.ph-recent-item').forEach((item) => {
      item.addEventListener('click', () => startCall(item.dataset.number, null));
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  renderDialPad();

  return () => {
    /* 无长期占用资源需要释放 */
  };
}

function injectPhoneStyles() {
  if (document.getElementById('phone-styles')) return;
  const style = document.createElement('style');
  style.id = 'phone-styles';
  style.textContent = `
    .ph-root { display:flex; flex-direction:column; height:100%; }
    .ph-pages { flex:1; overflow:hidden; position:relative; min-height:0; }
    .ph-page { position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch; }
    .ph-page-dial { display:flex; flex-direction:column; justify-content:space-between; padding: 6px 20px 20px; }
    .ph-display { padding: 20px 0 8px; text-align:center; }
    .ph-number-input { border:none; background:none; font-size:32px; text-align:center; width:100%; letter-spacing:2px; color:#1c1c1e; }
    .ph-keypad { display:grid; grid-template-columns: repeat(3, 1fr); gap:14px; padding: 6px 0; }
    .ph-key { aspect-ratio:1/1; border-radius:50%; background:#f0f0f2; display:flex; flex-direction:column; align-items:center; justify-content:center; }
    .ph-key:active { background:#dcdce0; }
    .ph-key-num { font-size:26px; font-weight:500; }
    .ph-key-sub { font-size:9px; color:#999; letter-spacing:1px; margin-top:2px; }
    .ph-call-row { display:flex; align-items:center; justify-content:space-between; padding: 10px 6px 0; }
    .ph-call-row-spacer, .ph-backspace { width:52px; height:52px; display:flex; align-items:center; justify-content:center; font-size:20px; color:#666; }
    .ph-call-btn { width:64px; height:64px; border-radius:50%; background:#34c759; color:#fff; font-size:26px; margin:0 auto; }
    .ph-call-btn:active { opacity:.8; }
    .ph-avatar, .ph-call-avatar { border-radius:50%; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; flex-shrink:0; }
    .ph-avatar { width:40px; height:40px; font-size:16px; }
    .ph-contact-info { flex:1; overflow:hidden; }
    .ph-contact-name { font-size:15px; }
    .ph-contact-phone { font-size:12px; color:#999; }
    .ph-contact-call { font-size:18px; color:#34c759; padding:6px; }
    .ph-recent-type { font-size:16px; width:24px; text-align:center; }

    .ph-modal { position:absolute; inset:0; background:rgba(0,0,0,.4); z-index:30; display:flex; align-items:center; justify-content:center; }
    .ph-modal-card { background:#fff; border-radius:16px; padding:20px; width:82%; max-width:320px; }
    .ph-modal-title { font-size:16px; font-weight:700; margin-bottom:14px; }
    .ph-modal-actions { display:flex; align-items:center; justify-content:space-between; margin-top:6px; }
    .ph-modal-actions .btn { margin-left:6px; padding:8px 14px; font-size:13px; }

    .ph-call-overlay { position:absolute; inset:0; background:linear-gradient(160deg,#1a1a2e,#16213e); z-index:25;
      display:flex; flex-direction:column; align-items:center; justify-content:space-between; padding: 60px 30px 50px; color:#fff; }
    .ph-call-avatar { width:96px; height:96px; font-size:40px; margin-top:20px; }
    .ph-call-name { font-size:22px; font-weight:600; margin-top:14px; }
    .ph-call-status { font-size:14px; opacity:.7; margin-top:6px; }
    .ph-call-actions { display:flex; gap:24px; margin: 30px 0; }
    .ph-call-action-btn { display:flex; flex-direction:column; align-items:center; gap:6px; font-size:22px;
      background:rgba(255,255,255,.12); width:60px; height:60px; border-radius:50%; justify-content:center; }
    .ph-call-action-btn span { font-size:10px; opacity:.8; }
    .ph-call-action-btn.active { background:#fff; color:#1a1a2e; }
    .ph-hangup { width:64px; height:64px; border-radius:50%; background:#ff3b30; font-size:26px; transform:rotate(135deg); }
  `;
  document.head.appendChild(style);
}
