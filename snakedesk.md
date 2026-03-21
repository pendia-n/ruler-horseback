# Snakedesk — Original Behavior Reference

## Overview
Snakedesk is a **Tkinter (Python)** desktop todo app with a **MySQL** backend. It tracks todos with deadlines and countdown timers.

---

## Auth

| Field | Rule |
|-------|------|
| Login/Register | Auto-detected: typing a username and waiting 300ms checks if it exists. If yes → "Login" button. If no → "Register" button. |
| Password visibility | Password field hidden until username check completes. |
| Register validation | Password must be ≥7 chars, contain 1 uppercase letter, 1 digit. |
| Auth flow | On success → Dashboard opens, auth window closes. |
| No reset/edit/delete user | Not implemented. |

---

## Dashboard — Upcoming Todos

| Aspect | Detail |
|--------|--------|
| **Visible count** | Max **7** upcoming todos (`LIMIT 7` in SQL, line 343 of `fa.py`) |
| **Columns** | ID, Title, Countdown |
| **Countdown** | Auto-updates every **~2.6 seconds** (`2600ms` interval, line 315) |
| **Overdue behavior** | Items are **deleted** from the upcoming list when deadline passes (not hidden). They disappear silently. |
| **Navigation** | "View All Todos" button opens a new window with all todos. |

### SQL Query (line 340-344)
```sql
SELECT id, title, deadline FROM todos
WHERE user_id=%s AND deadline >= NOW()
ORDER BY deadline ASC LIMIT 7
```

---

## Adding a Todo

| Field | Required | Notes |
|-------|----------|-------|
| Title | Yes | Text entry, ~45 char max (Tkinter Entry widget) |
| Description | No | Text entry, ~45 char max |
| Deadline date | Yes | DatePicker dialog (custom calendar widget), defaults to today |
| Deadline time | Yes | HH:MM format, defaults to 12:00 |
| **Max in upcoming** | 7 | Oldest-expired items are silently removed from dashboard |

- On success: form clears, upcoming list refreshes.
- On error: `messagebox.showerror` popup.

---

## Editing a Todo

- **Trigger**: Select a row in the upcoming table → "Edit/View Selected" button, OR click "Edit" in the "All Todos" window.
- **Fields editable**: Title, Description, Deadline date+time.
- **Deadline edit limit**: Deadline can only be changed **once**.

### Deadline Lock Logic (lines 482-507)
```python
# In UI: if edit_count >= 1, date button is disabled
if row[3] >= 1:
    date_btn.configure(state='disabled')

# In Save:
increment = 1 if new_deadline != cur_deadline and row[3] < 1 else 0
if increment and row[3] >= 1:
    messagebox.showerror("Error", "Deadline can only be edited once.")
    return
# UPDATE ... edit_count = edit_count + 1
```

### `edit_count` Rules
| Situation | Result |
|----------|--------|
| First deadline edit | `edit_count` becomes 1, save succeeds |
| Second deadline edit attempt | Date picker disabled, save blocked with error message |
| Title/description edits | Unlimited |

---

## View All Todos

- Opens in a **new window** (`Toplevel`).
- Shows **all todos** (no pagination, no limit).
- Columns: ID, Title, Deadline, Status, Edit.
- Overdue rows: red text, bold font.
- "Edit" column: clickable blue "Edit" text → opens edit dialog for that todo.

### Status Calculation (line 399)
```python
diff = row[2] - now
status = "OVERDUE" if diff.total_seconds() <= 0 else f"{diff.days}d {diff.seconds//3600}h {(diff.seconds%3600)//60}m"
```

---

## Logout

- Click "Logout" → `askyesno` confirmation dialog.
- Cancels countdown timer.
- Destroys dashboard, returns to auth screen.

---

## Color Palette (Original — Dark)

| Element | Color |
|---------|-------|
| Background | `#2b2b2b` |
| Surface | `#3b3b3b` |
| Heading bg | `#555` |
| Accent | `#0078d7` |
| Text | `#e0e0e0` |
| Overdue | `#ff4444` |
| Theme | 'clam' |

---

## Notable Gaps in Original UX

1. **No delete** — individual todos cannot be deleted.
2. **No search/filter** — only "View All" to see everything.
3. **No bulk operations**.
4. **Overdue = silent removal** from dashboard — no notification.
5. **No deadline history** — only `edit_count`, not what was changed.
6. **No dark/light mode toggle**.
