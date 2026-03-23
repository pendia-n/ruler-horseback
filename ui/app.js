const invoke = window.__TAURI_INTERNALS__.invoke;

let currentUser = null;
let countdownInterval = null;
let pendingTodos = [];
let userCredits = 0;

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

function hideMsg(el) {
    el.className = 'msg';
}

// ── CREDITS ──────────────────────────────────────────────
async function fetchCredits() {
    if (!currentUser) return;
    try {
        const info = await invoke('get_credits', { userId: currentUser.id });
        userCredits = info.credits;
        updateCreditDisplay();
        checkBannerConditions(info);
    } catch (e) {
        console.error('Failed to fetch credits:', e);
    }
}

function updateCreditDisplay() {
    const el = document.getElementById('credit-balance');
    if (el) {
        el.textContent = `${userCredits} units`;
    }
}

async function checkBannerConditions(info) {
    if (!currentUser) return;
    try {
        const stats = await invoke('get_credits', { userId: currentUser.id });
        if (info.weekly_deletions >= 7 && info.credits >= 50) {
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
        }, 5000);
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
                mode = await invoke('check_username', { username: u });
                pwGroup.style.display = 'block';
                submitBtn.style.display = 'flex';
                submitBtn.disabled = false;
                submitText.textContent = mode === 'register' ? 'Create Account' : 'Sign In';
                pwHint.textContent = mode === 'register'
                    ? 'Min 7 chars, 1 uppercase, 1 digit'
                    : '';
                pwInput.value = '';
                pwInput.focus();
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
            if (mode === 'register') {
                result = await invoke('register_user', { username: u, password: p });
            } else {
                result = await invoke('login_user', { username: u, password: p });
            }

            if (result.success) {
                currentUser = { id: result.user_id, username: u };
                userCredits = 50; // default for new users
                saveSession();
                render();
                fetchCredits();
            } else {
                showMsg(msgEl, result.message, 'error');
            }
        } catch (e) {
            showMsg(msgEl, 'Error: ' + e, 'error');
        } finally {
            submitBtn.disabled = false;
            submitText.textContent = mode === 'register' ? 'Create Account' : 'Sign In';
        }
    });
}

function renderDashboard(container) {
    container.innerHTML = `
        <div class="dashboard">
            <header class="dash-header">
                <div class="logo">ruler<span>horseback</span></div>
                <div class="dash-header-actions">
                    <div class="credit-display">
                        <span class="credit-icon">&#128176;</span>
                        <span id="credit-balance">${userCredits} units</span>
                    </div>
                    <button class="btn btn-secondary btn-sm" id="btn-all">View All Todos</button>
                    <button class="btn btn-ghost btn-sm" id="btn-logout">Logout</button>
                </div>
            </header>
            <div class="credit-banner" id="credit-banner">
                <div class="banner-content">
                    <span class="banner-icon">&#9888;</span>
                    <span>You've used your weekly free deletes. Deletions now cost 50 units (5 credits).</span>
                    <button class="close-btn" id="close-banner">&times;</button>
                </div>
            </div>
            <div class="dash-body">
                <div class="add-form">
                    <h2>Add New Todo</h2>
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
                    <div id="add-msg" class="msg"></div>
                    <div class="form-actions">
                        <button class="btn btn-primary" id="btn-add-todo">Add Todo</button>
                    </div>
                </div>

                <div class="todo-section">
                    <div class="todo-section-header">
                        <h2>Upcoming</h2>
                        <span class="todo-count" id="upcoming-count">0 / 7</span>
                    </div>
                    <table class="todo-table">
                        <thead>
                            <tr>
                                <th class="col-id">#</th>
                                <th class="col-title">Title</th>
                                <th class="col-countdown">Countdown</th>
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
    document.getElementById('close-banner').addEventListener('click', () => {
        document.getElementById('credit-banner').classList.remove('show');
    });

    loadUpcoming();
    startCountdown();
    fetchCredits();
}

function renderAllTodosModal(todos) {
    let overlay = document.getElementById('modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'modal-overlay';
        document.body.appendChild(overlay);
    }

    const overdueCount = todos.filter(t => t.status === 'OVERDUE').length;
    let rows = '';
    if (todos.length === 0) {
        rows = `<tr><td colspan="5"><div class="empty-state"><div class="icon">&#9744;</div><p>No todos yet.</p></div></td></tr>`;
    } else {
        todos.forEach(t => {
            const isOv = t.status === 'OVERDUE';
            rows += `
                <tr class="${isOv ? 'overdue-row' : ''}">
                    <td class="col-id">#${t.id}</td>
                    <td class="col-title">${escHtml(t.title)}</td>
                    <td class="col-countdown">${escHtml(t.deadline.slice(0, 16))}</td>
                    <td class="col-status ${isOv ? 'overdue' : 'pending'}">${escHtml(t.status)}</td>
                    <td class="col-action">
                        <button class="btn btn-secondary btn-sm btn-edit-all ${isOv ? 'btn-disabled' : ''}" data-id="${t.id}" ${isOv ? 'disabled' : ''}>Edit</button>
                        <button class="btn btn-danger btn-sm btn-delete-all ${isOv ? 'btn-disabled' : ''}" data-id="${t.id}" ${isOv ? 'disabled' : ''}>Delete</button>
                    </td>
                </tr>`;
        });
    }

    overlay.innerHTML = `
        <div class="modal all-todos-modal">
            <div class="modal-header">
                <h2>All Todos (${todos.length}${overdueCount > 0 ? ', ' + overdueCount + ' overdue' : ''})</h2>
                <button class="close-btn" id="close-all-modal">&times;</button>
            </div>
            <table class="todo-table">
                <thead>
                    <tr>
                        <th class="col-id">#</th>
                        <th class="col-title">Title</th>
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

    overlay.querySelectorAll('.btn-edit-all').forEach(btn => {
        btn.addEventListener('click', () => {
            closeModals();
            openEditModal(parseInt(btn.dataset.id));
        });
    });

    overlay.querySelectorAll('.btn-delete-all').forEach(btn => {
        btn.addEventListener('click', () => {
            handleDeleteTodo(parseInt(btn.dataset.id));
            closeModals();
        });
    });
}

function renderEditModal(todo) {
    const { date: defDate, time: defTime } = formatDeadline(todo.deadline);
    const locked = todo.edit_count >= 1;
    
    // Calculate edit cost based on edit_count
    let editCost = 0;
    if (todo.edit_count === 0) {
        editCost = 0;
    } else if (todo.edit_count >= 1 && todo.edit_count <= 4) {
        editCost = 4;
    } else {
        editCost = 100;
    }

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
                <span>Edit cost: <strong>${editCost} units</strong> (${(editCost / 10).toFixed(1)} credits)</span>
                <span>Your balance: <strong>${userCredits} units</strong></span>
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
                    <input type="date" id="edit-date" value="${defDate}" ${locked ? 'disabled' : ''} />
                    <input type="time" id="edit-time" value="${defTime}" />
                </div>
                ${locked ? '<div class="deadline-locked-msg">&#128274; Deadline has already been edited once.</div>' : ''}
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
            await invoke('update_todo', {
                id: todo.id,
                title,
                description: desc,
                deadline,
                editCount: todo.edit_count,
                currentDeadline: todo.deadline,
                userId: currentUser.id,
            });
            closeModals();
            loadUpcoming();
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
    if (overlay) overlay.classList.remove('active');
}

// ── ACTIONS ──────────────────────────────────────────────
async function handleAddTodo() {
    const title = document.getElementById('todo-title').value.trim();
    const desc = document.getElementById('todo-desc').value.trim();
    const date = document.getElementById('todo-date').value;
    const time = document.getElementById('todo-time').value;
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
        });
        document.getElementById('todo-title').value = '';
        document.getElementById('todo-desc').value = '';
        document.getElementById('todo-time').value = '12:00';
        hideMsg(msgEl);
        loadUpcoming();
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

    count.textContent = `${todos.length} / 7`;

    if (todos.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = todos.map(t => `
        <tr data-id="${t.id}">
            <td class="col-id">#${t.id}</td>
            <td class="col-title">${escHtml(t.title)}</td>
            <td class="col-countdown" data-deadline="${t.deadline}">&mdash;</td>
            <td class="col-action">
                <button class="btn btn-secondary btn-sm btn-edit" data-id="${t.id}">Edit</button>
                <button class="btn btn-danger btn-sm btn-delete" data-id="${t.id}" title="Delete todo">Delete</button>
            </td>
        </tr>
    `).join('');

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
    let anyOverdue = false;

    rows.forEach(row => {
        const cell = row.querySelector('.col-countdown');
        const deadline = cell.dataset.deadline;
        const label = countdownLabel(deadline);
        if (!label) {
            anyOverdue = true;
        } else {
            cell.textContent = label;
        }
    });

    if (anyOverdue) {
        setTimeout(loadUpcoming, 1000);
    }
}

function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(updateCountdowns, 3000);
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
    
    const confirmed = confirm('Are you sure you want to delete this todo?');
    if (!confirmed) return;

    try {
        await invoke('delete_todo', { id: todoId, userId: currentUser.id });
        loadUpcoming();
        fetchCredits();
    } catch (e) {
        alert('Failed to delete: ' + e);
    }
}

// ── SESSION ───────────────────────────────────────────────
function saveSession() {
    try {
        localStorage.setItem('rh_user', JSON.stringify(currentUser));
    } catch (e) {}
}

function clearSession() {
    try {
        localStorage.removeItem('rh_user');
    } catch (e) {}
}

function loadSession() {
    try {
        const s = localStorage.getItem('rh_user');
        if (s) {
            currentUser = JSON.parse(s);
            fetchCredits();
        }
    } catch (e) {}
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
        invoke('check_username', { username: '__test__' })
            .then(function(mode) {
                loadSession();
                render();
            })
            .catch(function(e) {
                showError('Backend error: ' + (e && e.message ? e.message : String(e)));
            });
    } catch (e) {
        console.error('Init error:', e);
        showError('Init error: ' + (e.stack || e.message || String(e)));
    }
})();
