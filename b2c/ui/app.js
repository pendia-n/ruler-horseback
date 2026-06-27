const invoke = window.__TAURI_INTERNALS__.invoke;
const API = 'https://rulerhorseback-api.pendia-community.workers.dev';

// Open URL in system browser via Tauri command
function openExternal(url) {
    invoke('open_external', { url }).catch(() => {});
}

let currentUser = null;
let countdownInterval = null;
let pendingTodos = [];
let userCredits = 0;
let authToken = null;

// ── UTILS ────────────────────────────────────────────────
function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function formatDeadline(deadlineStr) {
    const d = new Date(deadlineStr.replace(' ', 'T'));
    const ds = d.toISOString().split('T')[0];
    const time = d.toTimeString().slice(0, 5);
    return { date: ds, time };
}

function countdownLabel(deadlineStr) {
    const now = new Date();
    const d = new Date(deadlineStr.replace(' ', 'T'));
    const diff = d - now;
    if (diff <= 0) return null;
    const days = Math.floor(diff / 86400000);
    const hrs = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    if (days > 0) return `${days}d ${hrs}h ${mins}m`;
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
}

function isOverdue(deadlineStr) {
    return new Date(deadlineStr.replace(' ', 'T')) <= new Date();
}

function showMsg(el, msg, type = 'error') {
    el.textContent = msg;
    el.className = `msg msg-${type} show`;
}

function showMsgHtml(el, html, type = 'error') {
    el.innerHTML = html;
    el.className = `msg msg-${type} show`;
}

function hideMsg(el) {
    el.className = 'msg';
}

// ── CREDITS ──────────────────────────────────────────────
async function fetchCredits() {
    if (!currentUser) return;
    try {
        // Get D1 balance from worker
        let d1Balance = userCredits;
        if (authToken) {
            const res = await fetch(`${API}/api/credits/status`, {
                headers: { 'Authorization': `Bearer ${authToken}` },
            });
            if (res.ok) {
                const data = await res.json();
                userCredits = data.credits; // credits from D1, direct
            }
        }
        // Get local stats (weekly deletions, costs)
        const info = await invoke('get_credit_info', { userId: currentUser.id });
        updateCreditDisplay();
        checkBannerConditions(info);
    } catch (e) {
        console.error('Failed to fetch credits:', e);
    }
}

function updateCreditDisplay() {
    const el = document.getElementById('credit-balance');
    if (el) {
        el.textContent = `${userCredits} credits`;
    }
}

async function checkBannerConditions(info) {
    if (!currentUser) return;
    try {
        const stats = await invoke('get_credit_info', { userId: currentUser.id });
        if (stats.weekly_deletions >= 7 && userCredits >= 500) {
            showBanner();
        }
    } catch (e) {
        console.error('Banner check failed:', e);
    }
}

function showBanner() {
    const banner = document.getElementById('credit-banner');
    if (banner) {
        banner.classList.add('show');
        setTimeout(() => {
            banner.classList.remove('show');
        }, 1000);
    }
}

// ── RENDER ───────────────────────────────────────────────
function render() {
    const app = document.getElementById('app');
    if (!currentUser) {
        renderAuth(app);
    } else {
        renderDashboard(app);
    }
}

function renderAuth(container) {
    container.innerHTML = `
        <div class="auth-screen">
            <div class="auth-card">
                <div class="auth-logo">
                    <h1>rulerhorseback</h1>
                    <p>Your personal deadline tracker</p>
                </div>
                <div id="auth-msg" class="msg"></div>
                <div class="form-group">
                    <label>Username</label>
                    <input type="text" id="auth-user" placeholder="Enter username" autocomplete="off" />
                </div>
                <div class="form-group" id="pw-group" style="display:none;">
                    <label>Password</label>
                    <input type="password" id="auth-pw" placeholder="Enter password" />
                    <p class="hint" id="pw-hint"></p>
                </div>
                <button class="btn btn-primary" id="auth-submit" style="display:none;" disabled>
                    <span id="submit-text">Submit</span>
                </button>
            </div>
        </div>
    `;

    const userInput = document.getElementById('auth-user');
    const pwGroup = document.getElementById('pw-group');
    const pwInput = document.getElementById('auth-pw');
    const pwHint = document.getElementById('pw-hint');
    const submitBtn = document.getElementById('auth-submit');
    const submitText = document.getElementById('submit-text');
    const msgEl = document.getElementById('auth-msg');

    let mode = null;
    let checkTimer = null;

    userInput.addEventListener('input', () => {
        hideMsg(msgEl);
        if (checkTimer) clearTimeout(checkTimer);
        checkTimer = setTimeout(async () => {
            const u = userInput.value.trim();
            if (!u) {
                pwGroup.style.display = 'none';
                submitBtn.style.display = 'none';
                mode = null;
                return;
            }
            try {
                // Check username against D1 via worker API
                const res = await fetch(`${API}/api/auth/check-username?username=${encodeURIComponent(u)}`);
                const data = await res.json();
                if (data.available) {
                    // Account doesn't exist on D1
                    pwGroup.style.display = 'none';
                    submitBtn.style.display = 'none';
                    showMsgHtml(msgEl, 'Account does not exist. <button id="btn-create-account" style="background:none;border:none;color:#60a5fa;text-decoration:underline;cursor:pointer;font:inherit;padding:0;">Create one on the website</button>', 'error');
                    setTimeout(() => {
                        const btn = document.getElementById('btn-create-account');
                        if (btn) btn.addEventListener('click', () => openExternal('https://rulerhorseback-api.pendia-community.workers.dev'));
                    }, 0);
                    mode = null;
                } else {
                    // Account exists, show password
                    pwGroup.style.display = 'block';
                    submitBtn.style.display = 'flex';
                    submitBtn.disabled = false;
                    submitText.textContent = 'Sign In';
                    pwHint.textContent = '';
                    hideMsg(msgEl);
                    pwInput.value = '';
                    pwInput.focus();
                    mode = 'login';
                }
            } catch (e) {
                showMsg(msgEl, 'Connection error: ' + e, 'error');
            }
        }, 300);
    });

    pwInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitBtn.click();
    });

    submitBtn.addEventListener('click', async () => {
        const u = userInput.value.trim();
        const p = pwInput.value;
        if (!u || !p) return;

        submitBtn.disabled = true;
        submitText.innerHTML = '<span class="loading-spinner"></span>';

        try {
            hideMsg(msgEl);
            let result;
            if (mode === 'login') {
                const res = await fetch(`${API}/api/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: u, password: p }),
                });
                result = await res.json();
                if (result.success) {
                    authToken = result.token;
                }
            } else {
                result = { success: false, message: 'Register is not available in the app.' };
            }

            if (result.success) {
                currentUser = { id: result.userId, username: u };
                userCredits = result.credits || 0;
                saveSession();
                render();
                fetchCredits();
            } else {
                showMsg(msgEl, result.error || 'Login failed', 'error');
            }
        } catch (e) {
            showMsg(msgEl, 'Error: ' + e, 'error');
        } finally {
            submitBtn.disabled = false;
            submitText.textContent = 'Sign In';
        }
    });
}

function renderDashboard(container) {
    container.innerHTML = `
        <div class="dashboard">
            <header class="dash-header">
                <div class="logo">ruler<span>horseback</span></div>
                <div class="dash-header-actions">
                    <div class="active-count" id="active-count" title="Active todos (max 35)">
                        <span class="active-count-icon">⚡</span>
                        <span id="active-count-text">0 / 35</span>
                    </div>
                    <div class="credit-display">
                        <span class="credit-icon">&#128176;</span>
                        <span id="credit-balance">${userCredits} credits</span>
                    </div>
                    <button class="btn btn-secondary btn-sm" id="btn-all">View All Todos</button>
                    <button class="btn btn-ghost btn-sm" id="btn-logout">Logout</button>
                    <button class="btn btn-primary btn-sm" id="btn-buy" title="Buy credits on the website">+ Buy Credits</button>
                </div>
            </header>
            <div class="credit-banner" id="credit-banner">
                <div class="banner-content">
                    <span class="banner-icon">&#9888;</span>
                    <span>You've used your weekly free deletes. Deletions now cost 50 credits.</span>
                    <button class="close-btn" id="close-banner">&times;</button>
                </div>
            </div>
            <div class="dash-body">
                <div class="add-form">
                    <h2>Add New Todo</h2>
                    <div id="cap-warning" class="msg msg-error" style="display:none;"></div>
                    <div class="form-group">
                        <label>Title *</label>
                        <input type="text" id="todo-title" placeholder="What needs to be done?" maxlength="255" />
                    </div>
                    <div class="form-group">
                        <label>Description</label>
                        <input type="text" id="todo-desc" placeholder="Optional details..." maxlength="255" />
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label>Deadline Date *</label>
                            <div class="date-input">
                                <input type="date" id="todo-date" />
                                <input type="time" id="todo-time" value="12:00" />
                            </div>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Category</label>
                        <div class="category-row">
                            <select id="todo-category">
                                <option value="">No category</option>
                            </select>
                            <button type="button" class="btn btn-secondary btn-sm" id="btn-manage-cats">+</button>
                        </div>
                    </div>
                    <div id="add-msg" class="msg"></div>
                    <div class="form-actions">
                        <button class="btn btn-primary" id="btn-add-todo">Add Todo</button>
                    </div>
                </div>

                <div class="todo-section">
<div class="todo-section-header">
    <h2>Upcoming</h2>
    <span class="todo-count" id="upcoming-count">0 / 35</span>
</div>
<table class="todo-table">
    <thead>
        <tr>
            <th class="col-id">#</th>
            <th class="col-title">Title</th>
            <th class="col-category">Category</th>
            <th class="col-countdown">Countdown</th>
            <th class="col-edit-cost">Edit Cost</th>
            <th class="col-action">Action</th>
        </tr>
    </thead>
                        <tbody id="upcoming-tbody">
                        </tbody>
                    </table>
                    <div class="empty-state" id="upcoming-empty" style="display:none;">
                        <div class="icon">&#9744;</div>
                        <p>No upcoming todos. Add one above!</p>
                    </div>
                </div>
            </div>
            <div class="dash-footer">rulerhorseback &mdash; deadline tracker</div>
        </div>

        <div class="modal-overlay" id="modal-overlay"></div>
    `;

    // Set default date to today
    document.getElementById('todo-date').value = formatDate(new Date());

    document.getElementById('btn-add-todo').addEventListener('click', handleAddTodo);
    document.getElementById('btn-all').addEventListener('click', openAllTodos);
    document.getElementById('btn-logout').addEventListener('click', handleLogout);
    document.getElementById('btn-buy').addEventListener('click', () => {
        openExternal('https://rulerhorseback-api.pendia-community.workers.dev');
    });
    document.getElementById('close-banner').addEventListener('click', () => {
        document.getElementById('credit-banner').classList.remove('show');
    });

    (async () => {
        const cats = await loadCategories();
        const catSelect = document.getElementById('todo-category');
        cats.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            catSelect.appendChild(opt);
        });
    })();

    document.getElementById('btn-manage-cats')?.addEventListener('click', openCategoryModal);

    loadUpcoming();
    startCountdown();
    fetchCredits();
    loadActiveCount();
    // Detect due todos on load and apply penalties
    applyDuePenalties();
}

// ── Active count ──────────────────────────────────────────

async function loadActiveCount() {
    if (!currentUser) return;
    try {
        const info = await invoke('get_active_count', { userId: currentUser.id });
        const el = document.getElementById('active-count-text');
        if (el) el.textContent = `${info.active} / ${info.max_active}`;
        // Update upcoming count too
        const uc = document.getElementById('upcoming-count');
        if (uc) uc.textContent = `${info.active} / ${info.max_active}`;
        // Warning if at cap
        const warning = document.getElementById('cap-warning');
        const addBtn = document.getElementById('btn-add-todo');
        if (info.active >= info.max_active) {
            if (warning) {
                warning.textContent = `Active todo cap reached (${info.max_active}). Complete, lose, or let some expire before adding more.`;
                warning.style.display = 'block';
                warning.className = 'msg msg-error show';
            }
            if (addBtn) addBtn.disabled = true;
        } else {
            if (warning) warning.style.display = 'none';
            if (addBtn) addBtn.disabled = false;
        }
    } catch (e) {
        console.error('Load active count failed:', e);
    }
}

// ── Due detection ─────────────────────────────────────────

async function applyDuePenalties() {
    if (!currentUser) return;
    try {
        const result = await invoke('detect_due_todos', { userId: currentUser.id });
        if (result.due_count > 0) {
            // Deduct credits via worker (-3 per due todo)
            if (authToken) {
                await fetch(`${API}/api/credits/apply-stats`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                    body: JSON.stringify({ done_count: 0, lost_count: 0, due_count: result.due_count }),
                });
                fetchCredits();
            }
            // Immediately fetch and display only pending todos (no due todos on dashboard)
            loadUpcoming();
            loadActiveCount();
        }
    } catch (e) {
        console.error('Due detection failed:', e);
    }
}

function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        updateCountdowns();
    }, 1500);
    // Backend pull: update active count and detect due todos every 5s (no blink)
    setInterval(() => {
        if (currentUser) {
            loadActiveCount();
            applyDuePenalties();
        }
    }, 1000);
    // UI blink: re-render dashboard table every 10s
    setInterval(() => {
        if (currentUser) {
            loadUpcoming();
        }
    }, 60000);
}

// ── Mark Done / Mark Lost modals ──────────────────────────

async function openMarkDoneModal(id) {
    const todo = await invoke('get_todo', { id, userId: currentUser.id }).catch(() => null);
    if (!todo) return;

    let overlay = document.getElementById('modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'modal-overlay';
        document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
        <div class="modal" style="max-width:480px;">
            <div class="modal-header">
                <h2>✓ Mark as Done</h2>
                <button class="close-btn" id="close-done-modal">&times;</button>
            </div>
            <p style="color:#94a3b8;font-size:0.85rem;margin-bottom:1rem;">
                <strong>${escHtml(todo.title)}</strong><br/>
                Deadline: ${escHtml(todo.deadline.slice(0, 16))}
            </p>
            <div id="done-resolution-field">
                <div class="form-group">
                    <label>How was this completed? *</label>
                    <textarea id="done-desc-input" rows="3" placeholder="Describe what you did — be specific. What was the outcome? Which files/tasks were involved?">${escHtml(todo.resolution || '')}</textarea>
                    <p class="hint" id="done-desc-hint">Min 12 chars, 3+ words. Specific descriptions get better credit scores.</p>
                </div>
            </div>
            <div id="done-msg" class="msg"></div>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancel-done">Cancel</button>
                <button class="btn btn-primary" id="confirm-done">Mark Done</button>
            </div>
        </div>
    `;
    overlay.classList.add('active');

    document.getElementById('close-done-modal').addEventListener('click', closeModals);
    document.getElementById('cancel-done').addEventListener('click', closeModals);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModals(); });

    document.getElementById('confirm-done').addEventListener('click', async () => {
        const desc = document.getElementById('done-desc-input').value.trim();
        const msgEl = document.getElementById('done-msg');
        const btn = document.getElementById('confirm-done');

        if (!desc) {
            showMsg(msgEl, 'Please describe how this was completed.', 'error');
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner"></span>';

        try {
            // Step 1: Rust backend validates description (junk filter)
            await invoke('mark_done', { id, userId: currentUser.id, resolution: desc });

            // Step 2: AI validation (rate limit: 1/min, +/-1 credit)
            if (authToken) {
                try {
                    const aiRes = await fetch(`${API}/api/ai/validate-description`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                        body: JSON.stringify({
                            todoTitle: todo.title,
                            todoDescription: todo.description || '',
                            createdDate: todo.created_at || '',
                            endDate: new Date().toISOString(),
                            type: 'done',
                            resolutionDescription: desc,
                        }),
                    });
                    if (aiRes.ok) {
                        const aiData = await aiRes.json();
                        // Show AI feedback briefly
                        const creditText = aiData.credit_change > 0 ? `+${aiData.credit_change} credit` : `${aiData.credit_change} credit`;
                        const scoreColor = aiData.passed ? '#16a34a' : '#dc2626';
                        showMsgHtml(msgEl, `AI score: <strong style="color:${scoreColor}">${aiData.score}/${aiData.maxScore}</strong> (${creditText})`, aiData.passed ? 'success' : 'error');
                    }
                    // If AI fails (rate limit, service down), continue anyway — not blocking
                } catch (aiErr) {
                    console.error('AI validation failed:', aiErr);
                }

                // Step 3: Batch credit sync (+5 per 10 done, etc.)
                await fetch(`${API}/api/credits/apply-stats`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                    body: JSON.stringify({ done_count: 1, lost_count: 0, due_count: 0 }),
                });
            }

            closeModals();
            loadUpcoming();
            fetchCredits();
            loadActiveCount();
        } catch (e) {
            showMsg(msgEl, e.toString(), 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Mark Done';
        }
    });
}

async function openMarkLostModal(id) {
    const todo = await invoke('get_todo', { id, userId: currentUser.id }).catch(() => null);
    if (!todo) return;

    let overlay = document.getElementById('modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'modal-overlay';
        document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
        <div class="modal" style="max-width:480px;">
            <div class="modal-header">
                <h2>✗ Mark as Lost</h2>
                <button class="close-btn" id="close-lost-modal">&times;</button>
            </div>
            <p style="color:#94a3b8;font-size:0.85rem;margin-bottom:1rem;">
                <strong>${escHtml(todo.title)}</strong><br/>
                Deadline: ${escHtml(todo.deadline.slice(0, 16))}
            </p>
            <div class="form-group">
                <label>Why was this lost? *</label>
                <textarea id="lost-desc-input" rows="3" placeholder="Explain why this todo was abandoned — be specific. What blocked it? Why is it no longer needed?"></textarea>
                <p class="hint">Min 12 chars, 3+ words. Helps track patterns.</p>
            </div>
            <div id="lost-msg" class="msg"></div>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancel-lost">Cancel</button>
                <button class="btn btn-danger" id="confirm-lost">Mark Lost</button>
            </div>
        </div>
    `;
    overlay.classList.add('active');

    document.getElementById('close-lost-modal').addEventListener('click', closeModals);
    document.getElementById('cancel-lost').addEventListener('click', closeModals);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModals(); });

    document.getElementById('confirm-lost').addEventListener('click', async () => {
        const desc = document.getElementById('lost-desc-input').value.trim();
        const msgEl = document.getElementById('lost-msg');
        const btn = document.getElementById('confirm-lost');

        if (!desc) {
            showMsg(msgEl, 'Please explain why this was lost.', 'error');
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner"></span>';

        try {
            // Step 1: Rust backend validates description (junk filter)
            await invoke('mark_lost', { id, userId: currentUser.id, reason: desc });

            // Step 2: AI validation (rate limit: 1/min, +/-1 credit)
            if (authToken) {
                try {
                    const aiRes = await fetch(`${API}/api/ai/validate-description`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                        body: JSON.stringify({
                            todoTitle: todo.title,
                            todoDescription: todo.description || '',
                            createdDate: todo.created_at || '',
                            endDate: new Date().toISOString(),
                            type: 'lost',
                            resolutionDescription: desc,
                        }),
                    });
                    if (aiRes.ok) {
                        const aiData = await aiRes.json();
                        const creditText = aiData.credit_change > 0 ? `+${aiData.credit_change} credit` : `${aiData.credit_change} credit`;
                        const scoreColor = aiData.passed ? '#16a34a' : '#dc2626';
                        showMsgHtml(msgEl, `AI score: <strong style="color:${scoreColor}">${aiData.score}/${aiData.maxScore}</strong> (${creditText})`, aiData.passed ? 'success' : 'error');
                    }
                } catch (aiErr) {
                    console.error('AI validation failed:', aiErr);
                }

                // Step 3: Batch credit sync (-10 per 5 lost, etc.)
                await fetch(`${API}/api/credits/apply-stats`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                    body: JSON.stringify({ done_count: 0, lost_count: 1, due_count: 0 }),
                });
            }

            closeModals();
            loadUpcoming();
            fetchCredits();
            loadActiveCount();
        } catch (e) {
            showMsg(msgEl, e.toString(), 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Mark Lost';
        }
    });
}

function renderAllTodosModal(todos) {
    let overlay = document.getElementById('modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'modal-overlay';
        document.body.appendChild(overlay);
    }

    const doneCount = todos.filter(t => t.completed).length;
    const lostCount = todos.filter(t => t.lost).length;
    const dueCount = todos.filter(t => t.status === 'DUE').length;
    let rows = '';
    if (todos.length === 0) {
        rows = `<tr><td colspan="8"><div class="empty-state"><div class="icon">&#9744;</div><p>No todos yet.</p></div></td></tr>`;
    } else {
        todos.forEach(t => {
            const isDue = t.status === 'DUE';
            const isCompleted = t.completed;
            const isLost = t.lost;
            const isTerminal = isCompleted || isLost || isDue;
            const cat = t.category_id ? categoriesCache.find(c => c.id === t.category_id) : null;
            const catCell = cat
                ? `<span class="cat-label" style="background:${cat.color}22;color:${cat.color};border:1px solid ${cat.color}44"><span class="cat-dot" style="background:${cat.color}"></span>${escHtml(cat.name)}</span>`
                : '';
            const statusClass = isCompleted ? 'status-done' : isLost ? 'status-lost' : isDue ? 'status-due' : 'status-pending';
            const resolutionHtml = t.resolution ? `<div class="resolution-text" style="font-size:0.75rem;color:#64748b;margin-top:4px;" title="${escHtml(t.resolution)}">${escHtml(t.resolution.slice(0, 60))}${t.resolution.length > 60 ? '...' : ''}</div>` : '';
            rows += `
                <tr class="${isDue ? 'due-row' : ''} ${isCompleted ? 'completed-row' : ''} ${isLost ? 'lost-row' : ''}">
                    <td class="col-id">#${t.id}</td>
                    <td class="col-title">${escHtml(t.title)}${resolutionHtml}</td>
                    <td class="col-category">${catCell}</td>
                    <td class="col-countdown">${escHtml(t.deadline.slice(0, 16))}</td>
                    <td class="col-status ${statusClass}">${escHtml(t.status)}</td>
                    <td class="col-action">
                        ${!isTerminal ? `
                            <button class="btn btn-success btn-sm btn-done-all" data-id="${t.id}" title="Mark as done">&#10003;</button>
                            <button class="btn btn-warning btn-sm btn-lost-all" data-id="${t.id}" title="Mark as lost">&#10007;</button>
                            <button class="btn btn-secondary btn-sm btn-edit-all" data-id="${t.id}">Edit</button>
                            <button class="btn btn-danger btn-sm btn-delete-all" data-id="${t.id}">Delete</button>
                        ` : '<span style="color:#64748b;font-size:0.8rem;">—</span>'}
                    </td>
                </tr>`;
        });
    }

    overlay.innerHTML = `
        <div class="modal all-todos-modal">
            <div class="modal-header">
                <h2>All Todos (${todos.length}${doneCount > 0 ? ', ' + doneCount + ' done' : ''}${lostCount > 0 ? ', ' + lostCount + ' lost' : ''}${dueCount > 0 ? ', ' + dueCount + ' due' : ''})</h2>
                <button class="close-btn" id="close-all-modal">&times;</button>
            </div>
            <div class="modal-filters">
                <input type="text" id="todo-search" placeholder="Search todos..." />
                <select id="filter-category">
                    <option value="">All Categories</option>
                </select>
                <select id="filter-status">
                    <option value="">All Status</option>
                    <option value="pending">Pending</option>
                    <option value="done">Done</option>
                    <option value="lost">Lost</option>
                    <option value="due">Due</option>
                </select>
            </div>
            <table class="todo-table">
                <thead>
                    <tr>
                        <th class="col-check"></th>
                        <th class="col-id">#</th>
                        <th class="col-title">Title</th>
                        <th class="col-category">Category</th>
                        <th class="col-countdown">Deadline</th>
                        <th class="col-status">Status</th>
                        <th class="col-action">Action</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
    overlay.classList.add('active');

    document.getElementById('close-all-modal').addEventListener('click', closeModals);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModals();
    });

    (async () => {
        const cats = await loadCategories();
        const filterCat = document.getElementById('filter-category');
        cats.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            filterCat.appendChild(opt);
        });
    })();

    const searchInput = document.getElementById('todo-search');
    const filterCat = document.getElementById('filter-category');
    const filterStatus = document.getElementById('filter-status');

    const applyFilters = () => {
        const search = searchInput.value.toLowerCase();
        const cat = filterCat.value;
        const status = filterStatus.value;
        
        const filtered = todos.filter(t => {
            const matchSearch = t.title.toLowerCase().includes(search) || (t.description && t.description.toLowerCase().includes(search));
            const matchCat = !cat || t.category_id == cat;
            let matchStatus = true;
            if (status === 'pending') matchStatus = !t.completed && !t.lost && t.status !== 'DUE';
            else if (status === 'done') matchStatus = t.completed;
            else if (status === 'lost') matchStatus = t.lost;
            else if (status === 'due') matchStatus = t.status === 'DUE';
            return matchSearch && matchCat && matchStatus;
        });
        
        const tbody = overlay.querySelector('tbody');
        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="icon">&#9744;</div><p>No matching todos.</p></div></td></tr>`;
        } else {
            tbody.innerHTML = filtered.map(t => {
                const isDue = t.status === 'DUE';
                const isCompleted = t.completed;
                const isLost = t.lost;
                const isTerminal = isCompleted || isLost || isDue;
                const cat = t.category_id ? categoriesCache.find(c => c.id === t.category_id) : null;
                const catCell = cat
                    ? `<span class="cat-label" style="background:${cat.color}22;color:${cat.color};border:1px solid ${cat.color}44"><span class="cat-dot" style="background:${cat.color}"></span>${escHtml(cat.name)}</span>`
                    : '';
                const statusClass = isCompleted ? 'status-done' : isLost ? 'status-lost' : isDue ? 'status-due' : 'status-pending';
                const resolutionHtml = t.resolution ? `<div class="resolution-text" style="font-size:0.75rem;color:#64748b;margin-top:4px;" title="${escHtml(t.resolution)}">${escHtml(t.resolution.slice(0, 60))}${t.resolution.length > 60 ? '...' : ''}</div>` : '';
                return `
                    <tr class="${isDue ? 'due-row' : ''} ${isCompleted ? 'completed-row' : ''} ${isLost ? 'lost-row' : ''}">
                        <td class="col-id">#${t.id}</td>
                        <td class="col-title">${escHtml(t.title)}${resolutionHtml}</td>
                        <td class="col-category">${catCell}</td>
                        <td class="col-countdown">${escHtml(t.deadline.slice(0, 16))}</td>
                        <td class="col-status ${statusClass}">${escHtml(t.status)}</td>
                        <td class="col-action">
                            ${!isTerminal ? `
                                <button class="btn btn-success btn-sm btn-done-all" data-id="${t.id}" title="Mark as done">&#10003;</button>
                                <button class="btn btn-warning btn-sm btn-lost-all" data-id="${t.id}" title="Mark as lost">&#10007;</button>
                                <button class="btn btn-secondary btn-sm btn-edit-all" data-id="${t.id}">Edit</button>
                                <button class="btn btn-danger btn-sm btn-delete-all" data-id="${t.id}">Delete</button>
                            ` : '<span style="color:#64748b;font-size:0.8rem;">—</span>'}
                        </td>
                    </tr>`;
            }).join('');
            
            tbody.querySelectorAll('.btn-done-all').forEach(btn => {
                btn.addEventListener('click', () => {
                    closeModals();
                    openMarkDoneModal(parseInt(btn.dataset.id));
                });
            });
            tbody.querySelectorAll('.btn-lost-all').forEach(btn => {
                btn.addEventListener('click', () => {
                    closeModals();
                    openMarkLostModal(parseInt(btn.dataset.id));
                });
            });
            tbody.querySelectorAll('.btn-edit-all').forEach(btn => {
                btn.addEventListener('click', () => {
                    closeModals();
                    openEditModal(parseInt(btn.dataset.id));
                });
            });
            tbody.querySelectorAll('.btn-delete-all').forEach(btn => {
                btn.addEventListener('click', () => {
                    handleDeleteTodo(parseInt(btn.dataset.id));
                    closeModals();
                });
            });
        }
    };

    searchInput.addEventListener('input', applyFilters);
    filterCat.addEventListener('change', applyFilters);
    filterStatus.addEventListener('change', applyFilters);
}

function renderEditModal(todo) {
    const { date: defDate, time: defTime } = formatDeadline(todo.deadline);
    
    // Calculate edit cost based on edit_count
    let editCost = todo.edit_cost;

    let overlay = document.getElementById('modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'modal-overlay';
        document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
        <div class="modal">
            <div class="modal-header">
                <h2>Edit Todo #${todo.id}</h2>
                <button class="close-btn" id="close-edit-modal">&times;</button>
            </div>
            <div class="edit-cost-info" ${editCost > 0 ? '' : 'style="display:none"'}>
                <span class="cost-icon">&#128176;</span>
                <span>Edit cost: <strong>${editCost} credits</strong></span>
                <span>Your balance: <strong>${userCredits} credits</strong></span>
            </div>
            <div id="edit-msg" class="msg"></div>
            <div class="form-group">
                <label>Title *</label>
                <input type="text" id="edit-title" value="${escHtml(todo.title)}" maxlength="255" />
            </div>
            <div class="form-group">
                <label>Description</label>
                <input type="text" id="edit-desc" value="${escHtml(todo.description || '')}" maxlength="255" />
            </div>
            <div class="form-group">
                <label>Deadline *</label>
                <div class="date-input">
                    <input type="date" id="edit-date" value="${defDate}" />
                    <input type="time" id="edit-time" value="${defTime}" />
                </div>
            </div>
            <div class="form-group">
                <label>Category</label>
                <select id="edit-category">
                    <option value="">No category</option>
                </select>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancel-edit">Cancel</button>
                <button class="btn btn-primary" id="save-edit">Save Changes</button>
            </div>
        </div>
    `;
    overlay.classList.add('active');

    document.getElementById('close-edit-modal').addEventListener('click', closeModals);
    document.getElementById('cancel-edit').addEventListener('click', closeModals);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModals();
    });

    (async () => {
        const cats = await loadCategories();
        const editCat = document.getElementById('edit-category');
        cats.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            if (todo.category_id === c.id) opt.selected = true;
            editCat.appendChild(opt);
        });
    })();

    document.getElementById('save-edit').addEventListener('click', async () => {
        const title = document.getElementById('edit-title').value.trim();
        const desc = document.getElementById('edit-desc').value.trim();
        const date = document.getElementById('edit-date').value;
        const time = document.getElementById('edit-time').value;
        const msgEl = document.getElementById('edit-msg');

        if (!title) {
            showMsg(msgEl, 'Title is required', 'error');
            return;
        }

        const deadline = `${date} ${time}:00`;
        const saveBtn = document.getElementById('save-edit');
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<span class="loading-spinner"></span>';

        try {
            const categorySelect = document.getElementById('edit-category');
            const categoryId = categorySelect && categorySelect.value ? parseInt(categorySelect.value) : null;
            
            // Get edit cost from Rust
            let editCost = 0;
            if (todo.edit_count >= 1) {
                editCost = await invoke('get_edit_cost_command', { userId: currentUser.id, todoId: todo.id });
            }
            
            // Deduct credits from D1 via worker (if cost > 0)
            if (editCost > 0 && authToken) {
                const res = await fetch(`${API}/api/credits/use`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                    body: JSON.stringify({ amount: editCost }), // cost is in credits directly
                });
                if (!res.ok) {
                    const err = await res.json();
                    showMsg(msgEl, err.error || 'Insufficient credits', 'error');
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save Changes';
                    return;
                }
            }
            
            await invoke('update_todo', {
                id: todo.id,
                title,
                description: desc,
                deadline,
                userId: currentUser.id,
                categoryId,
            });
            closeModals();
            loadUpcoming();
            loadActiveCount();
            fetchCredits();
        } catch (e) {
            showMsg(msgEl, e, 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Changes';
        }
    });
}

function closeModals() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) {
        overlay.classList.remove('active');
        overlay.innerHTML = '';
    }
    if (document.activeElement) document.activeElement.blur();
}

// ── ACTIONS ──────────────────────────────────────────────
let categoriesCache = [];

async function loadCategories() {
    if (!currentUser) return [];
    try {
        categoriesCache = await invoke('get_categories', { userId: currentUser.id });
        return categoriesCache;
    } catch (e) {
        console.error('Load categories failed:', e);
        return [];
    }
}

async function handleAddTodo() {
    const title = document.getElementById('todo-title').value.trim();
    const desc = document.getElementById('todo-desc').value.trim();
    const date = document.getElementById('todo-date').value;
    const time = document.getElementById('todo-time').value;
    const categorySelect = document.getElementById('todo-category');
    const categoryId = categorySelect && categorySelect.value ? parseInt(categorySelect.value) : null;
    const msgEl = document.getElementById('add-msg');

    if (!title || !date || !time) {
        showMsg(msgEl, 'Title, date, and time are required', 'error');
        return;
    }

    const deadline = `${date} ${time}:00`;

    const btn = document.getElementById('btn-add-todo');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span>';

    try {
        await invoke('add_todo', {
            userId: currentUser.id,
            title,
            description: desc,
            deadline,
            categoryId,
        });
        document.getElementById('todo-title').value = '';
        document.getElementById('todo-desc').value = '';
        document.getElementById('todo-time').value = '12:00';
        hideMsg(msgEl);
        loadUpcoming();
        loadActiveCount();
    } catch (e) {
        showMsg(msgEl, 'Error: ' + e, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Add Todo';
    }
}

async function loadUpcoming() {
    if (!currentUser) return;
    try {
        const todos = await invoke('get_upcoming_todos', { userId: currentUser.id });
        pendingTodos = todos;
        renderUpcomingTable(todos);
    } catch (e) {
        console.error('Load upcoming failed:', e);
    }
}

function renderUpcomingTable(todos) {
    const tbody = document.getElementById('upcoming-tbody');
    const empty = document.getElementById('upcoming-empty');
    const count = document.getElementById('upcoming-count');

    if (!tbody) return;

    // Get max active from the active-count display
    const activeCountEl = document.getElementById('active-count-text');
    const maxActive = activeCountEl ? activeCountEl.textContent.split('/')[1].trim() : 35;
    count.textContent = `${todos.length} / ${maxActive}`;

    if (todos.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = todos.map(t => {
        const cat = t.category_id ? categoriesCache.find(c => c.id === t.category_id) : null;
        const catCell = cat
            ? `<span class="cat-label" style="background:${cat.color}22;color:${cat.color};border:1px solid ${cat.color}44"><span class="cat-dot" style="background:${cat.color}"></span>${escHtml(cat.name)}</span>`
            : '';
        return `
        <tr data-id="${t.id}">
            <td class="col-id">#${t.id}</td>
            <td class="col-title">${escHtml(t.title)}</td>
            <td class="col-category">${catCell}</td>
            <td class="col-countdown" data-deadline="${t.deadline}">&mdash;</td>
            <td class="col-edit-cost">
                ${t.edit_cost > 0 ? `${t.edit_cost} credits` : 'Free'}
            </td>
            <td class="col-action">
                ${!t.completed && !t.lost ? `
                    <button class="btn btn-success btn-sm btn-done" data-id="${t.id}" title="Mark as done">&#10003;</button>
                    <button class="btn btn-warning btn-sm btn-lost" data-id="${t.id}" title="Mark as lost">&#10007;</button>
                    <button class="btn btn-secondary btn-sm btn-edit" data-id="${t.id}">Edit</button>
                    <button class="btn btn-danger btn-sm btn-delete" data-id="${t.id}" title="Delete todo">Delete</button>
                ` : '<span style="color:#64748b;font-size:0.8rem;">—</span>'}
            </td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('.btn-done').forEach(btn => {
        btn.addEventListener('click', () => openMarkDoneModal(parseInt(btn.dataset.id)));
    });
    tbody.querySelectorAll('.btn-lost').forEach(btn => {
        btn.addEventListener('click', () => openMarkLostModal(parseInt(btn.dataset.id)));
    });
    tbody.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', () => openEditModal(parseInt(btn.dataset.id)));
    });
    tbody.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', () => handleDeleteTodo(parseInt(btn.dataset.id)));
    });
}

function updateCountdowns() {
    const tbody = document.getElementById('upcoming-tbody');
    if (!tbody) return;

    const rows = tbody.querySelectorAll('tr');
    rows.forEach(row => {
        const cell = row.querySelector('.col-countdown');
        if (!cell) return;
        const deadline = cell.dataset.deadline;
        if (!deadline) return;
        const label = countdownLabel(deadline);
        cell.textContent = label || '—';
    });
}

async function openAllTodos() {
    try {
        const todos = await invoke('get_all_todos', { userId: currentUser.id });
        renderAllTodosModal(todos);
    } catch (e) {
        console.error('Load all todos failed:', e);
    }
}

async function openEditModal(id) {
    try {
        const todo = await invoke('get_todo', { id });
        renderEditModal(todo);
    } catch (e) {
        console.error('Load todo failed:', e);
    }
}

function handleLogout() {
    if (countdownInterval) clearInterval(countdownInterval);
    currentUser = null;
    userCredits = 0;
    clearSession();
    render();
}

async function handleDeleteTodo(todoId) {
    if (!currentUser) return;

    // Show custom confirm modal instead of confirm() which is blocked in Tauri
    let overlay = document.getElementById('modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'modal-overlay';
        document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
        <div class="modal" style="max-width:400px;">
            <div class="modal-header">
                <h2>Delete Todo</h2>
                <button class="close-btn" id="close-delete-modal">&times;</button>
            </div>
            <p style="margin:1rem 0;color:#94a3b8;">Are you sure you want to delete this todo? This cannot be undone.</p>
            <div id="delete-msg" class="msg"></div>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancel-delete">Cancel</button>
                <button class="btn btn-danger" id="confirm-delete">Delete</button>
            </div>
        </div>
    `;
    overlay.classList.add('active');

    document.getElementById('close-delete-modal').addEventListener('click', closeModals);
    document.getElementById('cancel-delete').addEventListener('click', closeModals);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModals(); });

    document.getElementById('confirm-delete').addEventListener('click', async () => {
        const msgEl = document.getElementById('delete-msg');
        const btn = document.getElementById('confirm-delete');
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner"></span>';

        try {
            // Get delete cost from local stats
            const info = await invoke('get_credit_info', { userId: currentUser.id });
            const cost = info.delete_cost;

            // Deduct credits from D1 via worker
            if (cost > 0 && authToken) {
                const res = await fetch(`${API}/api/credits/use`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                    body: JSON.stringify({ amount: cost }),
                });
                if (!res.ok) {
                    const err = await res.json();
                    showMsg(msgEl, err.error || 'Insufficient credits', 'error');
                    btn.disabled = false;
                    btn.textContent = 'Delete';
                    return;
                }
            }

            await invoke('delete_todo', { id: todoId, userId: currentUser.id });
            closeModals();
            loadUpcoming();
            loadActiveCount();
            fetchCredits();
        } catch (e) {
            showMsg(msgEl, e.toString(), 'error');
            btn.disabled = false;
            btn.textContent = 'Delete';
        }
    });
}

async function handleToggleCompleted(todoId) {
    if (!currentUser) return;
    try {
        await invoke('toggle_completed', { id: todoId, userId: currentUser.id });
        loadUpcoming();
        loadActiveCount();
    } catch (e) {
        alert('Failed to toggle: ' + e);
    }
}

// ── SESSION ───────────────────────────────────────────────
function saveSession() {
    try {
        localStorage.setItem('rh_user', JSON.stringify(currentUser));
        if (authToken) localStorage.setItem('rh_token', authToken);
    } catch (e) {}
}

function clearSession() {
    try {
        localStorage.removeItem('rh_user');
        localStorage.removeItem('rh_token');
    } catch (e) {}
}

function loadSession() {
    try {
        authToken = localStorage.getItem('rh_token');
        const s = localStorage.getItem('rh_user');
        if (s) {
            currentUser = JSON.parse(s);
            fetchCredits();
        }
    } catch (e) {}
}

function openCategoryModal() {
    let overlay = document.getElementById('modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'modal-overlay';
        document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
        <div class="modal">
            <div class="modal-header">
                <h2>Manage Categories</h2>
                <button class="close-btn" id="close-cat-modal">&times;</button>
            </div>
            <div class="form-group">
                <label>New Category</label>
                <div class="category-input-row">
                    <input type="text" id="new-cat-name" placeholder="Category name" maxlength="100" />
                    <input type="color" id="new-cat-color" value="#6366f1" />
                    <button class="btn btn-primary btn-sm" id="btn-add-cat">Add</button>
                </div>
            </div>
            <div id="cat-msg" class="msg"></div>
            <div class="category-list" id="category-list"></div>
        </div>
    `;
    overlay.classList.add('active');

    document.getElementById('close-cat-modal').addEventListener('click', closeModals);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModals();
    });

    renderCategoryList();

    document.getElementById('btn-add-cat').addEventListener('click', async () => {
        const name = document.getElementById('new-cat-name').value.trim();
        const color = document.getElementById('new-cat-color').value;
        const msgEl = document.getElementById('cat-msg');
        
        if (!name) {
            showMsg(msgEl, 'Category name required', 'error');
            return;
        }
        
        try {
            await invoke('create_category', { userId: currentUser.id, name, color });
            document.getElementById('new-cat-name').value = '';
            renderCategoryList();
            refreshCategoryDropdowns();
        } catch (e) {
            showMsg(msgEl, e, 'error');
        }
    });
}

async function renderCategoryList() {
    const list = document.getElementById('category-list');
    if (!list) return;
    
    const cats = await loadCategories();
    
    if (cats.length === 0) {
        list.innerHTML = '<p class="empty-state-text">No categories yet.</p>';
        return;
    }
    
    list.innerHTML = cats.map(c => `
        <div class="category-item">
            <span class="cat-color" style="background:${c.color}"></span>
            <span class="cat-name">${escHtml(c.name)}</span>
        </div>
    `).join('');
}

function buildSelectOptions(selectEl, cats, placeholder) {
    if (!selectEl) return;
    const selected = selectEl.value;
    while (selectEl.options.length > 1) {
        selectEl.remove(1);
    }
    cats.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        selectEl.appendChild(opt);
    });
    selectEl.value = selected;
}

async function refreshCategoryDropdowns() {
    const cats = await loadCategories();
    buildSelectOptions(document.getElementById('todo-category'), cats, 'No category');
    buildSelectOptions(document.getElementById('edit-category'), cats, 'No category');
    const filterCat = document.getElementById('filter-category');
    if (filterCat) {
        const selected = filterCat.value;
        while (filterCat.options.length > 1) {
            filterCat.remove(1);
        }
        cats.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            filterCat.appendChild(opt);
        });
        filterCat.value = selected;
    }
}

// ── HELPERS ───────────────────────────────────────────────
function escHtml(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── INIT ─────────────────────────────────────────────────
(function init() {
    function showError(msg) {
        document.getElementById('app').innerHTML = '<div style="padding:2rem;font-family:sans-serif;color:#ef4444;background:#fef2f2;min-height:100vh;box-sizing:border-box;"><h2>Startup Error</h2><p>' + escHtml(msg) + '</p></div>';
    }
    try {
        if (typeof invoke === 'undefined') {
            showError('Tauri invoke not found. Is window.__TAURI_INTERNALS__ defined? ' + (typeof window.__TAURI_INTERNALS__ !== 'undefined' ? 'YES' : 'NO'));
            return;
        }
        loadSession();
        render();
    } catch (e) {
        console.error('Init error:', e);
        showError('Init error: ' + (e.stack || e.message || String(e)));
    }
})();
