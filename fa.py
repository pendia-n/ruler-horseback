import tkinter as tk
from tkinter import ttk, messagebox
import mysql.connector
import hashlib
from datetime import datetime, date
import calendar
import os

# --------------------------------------------------------------
# DB CONNECTION
# --------------------------------------------------------------
def get_db_connection():
    return mysql.connector.connect(
        host="localhost",
        user="nosensetxt",
        password="qweasdzxc",
        database="snakedesk"
    )

def hash_password(pw: str) -> str:
    return hashlib.sha256(pw.encode()).hexdigest()

# --------------------------------------------------------------
# CUSTOM DATE PICKER – BULLETPROOF
# --------------------------------------------------------------
class DatePickerDialog:
    def __init__(self, parent, callback, initial_date=None):
        self.callback = callback
        self.result = None
        self.top = tk.Toplevel(parent)
        self.top.title("Select Date")
        self.top.configure(bg="#2b2b2b")
        self.top.geometry("300x380")
        self.top.resizable(False, False)
        self.top.transient(parent)
        self.top.grab_set()

        parent.update_idletasks()
        x = parent.winfo_rootx() + parent.winfo_width() // 2 - 150
        y = parent.winfo_rooty() + parent.winfo_height() // 2 - 190
        self.top.geometry(f"+{x}+{y}")

        self.top.protocol("WM_DELETE_WINDOW", self.cancel)
        self.top.bind("<Escape>", lambda e: self.cancel())

        today = initial_date or date.today()
        self.year_var = tk.StringVar(value=str(today.year))
        self.month_var = tk.StringVar(value=str(today.month).zfill(2))

        frame_top = ttk.Frame(self.top)
        frame_top.pack(pady=10)

        ttk.Label(frame_top, text="Year:").grid(row=0, column=0, padx=5)
        tk.Spinbox(frame_top, from_=2000, to=2030, textvariable=self.year_var, width=6).grid(row=0, column=1, padx=5)
        ttk.Label(frame_top, text="Month:").grid(row=0, column=2, padx=5)
        tk.Spinbox(frame_top, values=[f"{i:02d}" for i in range(1, 13)], textvariable=self.month_var, width=4).grid(row=0, column=3, padx=5)

        self.year_var.trace_add("write", lambda *args: self.top.after_idle(self.update_calendar))
        self.month_var.trace_add("write", lambda *args: self.top.after_idle(self.update_calendar))

        self.day_buttons = []
        cal_frame = ttk.Frame(self.top)
        cal_frame.pack(pady=10)
        days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        for i, d in enumerate(days):
            ttk.Label(cal_frame, text=d, font=('Helvetica', 9, 'bold')).grid(row=0, column=i, padx=2, pady=2)
        for r in range(1, 7):
            row = []
            for c in range(7):
                btn = ttk.Button(cal_frame, text="", width=4, state='disabled')
                btn.grid(row=r, column=c, padx=1, pady=1)
                row.append(btn)
            self.day_buttons.append(row)

        btn_frame = ttk.Frame(self.top)
        btn_frame.pack(pady=15)
        ttk.Button(btn_frame, text="OK", command=self.ok).pack(side='left', padx=10)
        ttk.Button(btn_frame, text="Cancel", command=self.cancel).pack(side='left', padx=10)

        self.update_calendar()

    def update_calendar(self):
        try:
            year = int(self.year_var.get())
            month = int(self.month_var.get())
            if not (1 <= month <= 12): return
        except: return

        for r in range(6):
            for c in range(7):
                btn = self.day_buttons[r][c]
                btn.configure(text="", state='disabled', command=lambda: None)

        cal = calendar.monthcalendar(year, month)
        today = date.today()

        for week_idx, week in enumerate(cal):
            if week_idx >= 6: break
            for day_idx, day in enumerate(week):
                if day != 0:
                    r = week_idx
                    c = day_idx
                    #if r < 7 and c < 7:
                    btn = self.day_buttons[r][c]
                    btn.configure(
                        text=str(day), state='normal',
                        command=lambda d=day: self.select_day(year, month, d)
                    )
                    if date(year, month, day) == today:
                        btn.configure(style="Today.TButton")

        style = ttk.Style()
        style.configure("Today.TButton", background="#0078d7", foreground="white")

    def select_day(self, year, month, day):
        self.result = date(year, month, day)
        self.ok()

    def ok(self):
        self.top.destroy()
        if self.result:
            self.callback(self.result)

    def cancel(self):
        self.top.destroy()

# --------------------------------------------------------------
# AUTH SCREEN
# --------------------------------------------------------------
class AuthApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Snakedesk")
        self.root.configure(bg="#2b2b2b")
        self.root.geometry("380x260")
        self.root.resizable(False, False)

        # ICON
        icon_path = "snakedesk.png"
        if os.path.exists(icon_path):
            self.root.iconphoto(True, tk.PhotoImage(file=icon_path))

        self.mode = None
        self.username = tk.StringVar()
        self.password = tk.StringVar()
        self.check_timer = None

        style = ttk.Style()
        style.theme_use('clam')
        style.configure('TLabel', background='#2b2b2b', foreground='#e0e0e0')
        style.configure('TButton', font=('Helvetica', 11, 'bold'))

        ttk.Label(root, text="Username").pack(pady=(20, 5))
        self.user_entry = ttk.Entry(root, textvariable=self.username, width=30)
        self.user_entry.pack()
        self.user_entry.bind("<KeyRelease>", self._schedule_check)
        self.user_entry.focus_set()

        self.pw_label = ttk.Label(root, text="Password")
        self.pw_entry = ttk.Entry(root, textvariable=self.password, show="*", width=30)
        self.submit_btn = ttk.Button(root, text="", command=self._submit)

    def _schedule_check(self, _=None):
        if self.check_timer: self.root.after_cancel(self.check_timer)
        self.check_timer = self.root.after(300, self._check_username)

    def _check_username(self):
        uname = self.username.get().strip()
        if not uname: self._hide_pw_fields(); return
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM users WHERE username = %s", (uname,))
            exists = cur.fetchone()
            conn.close()
        except Exception as e:
            messagebox.showerror("Error", f"DB failed: {e}")
            return

        self.mode = 'register' if exists is None else 'login'
        self.submit_btn.configure(text=self.mode.title())
        self.pw_label.pack(pady=(15, 5))
        self.pw_entry.pack()
        self.submit_btn.pack(pady=15)
        self.pw_entry.focus_set()

    def _hide_pw_fields(self):
        for w in (self.pw_label, self.pw_entry, self.submit_btn):
            w.pack_forget()

    def _submit(self):
        uname = self.username.get().strip()
        pw = self.password.get()
        if self.mode == 'register':
            if len(pw) < 7 or not any(c.isupper() for c in pw) or not any(c.isdigit() for c in pw):
                messagebox.showerror("Error", "Password: >=7 chars, 1 capital, 1 digit")
                return

        try:
            conn = get_db_connection()
            cur = conn.cursor()
            if self.mode == 'register':
                cur.execute("INSERT INTO users (username, password_hash) VALUES (%s, %s)", (uname, hash_password(pw)))
                conn.commit()
                user_id = cur.lastrowid
                messagebox.showinfo("Success", "Registered!")
            else:
                cur.execute("SELECT user_id FROM users WHERE username=%s AND password_hash=%s", (uname, hash_password(pw)))
                row = cur.fetchone()
                if not row:
                    messagebox.showerror("Error", "Wrong password")
                    conn.close()
                    return
                user_id = row[0]
                messagebox.showinfo("Success", "Logged in!")
            conn.close()
        except Exception as e:
            messagebox.showerror("Error", f"DB error: {e}")
            return

        self.root.destroy()
        Dashboard(user_id).run()

# --------------------------------------------------------------
# DASHBOARD
# --------------------------------------------------------------
class Dashboard:
    def __init__(self, user_id: int):
        self.user_id = user_id
        self.root = tk.Tk()
        self.root.title("Snakedesk – Dashboard")
        self.root.configure(bg="#2b2b2b")
        self.root.geometry("900x680")
        self.root.minsize(800, 600)
        self.root.resizable(True, True)

        # ICON
        icon_path = "snakedesk.png"
        if os.path.exists(icon_path):
            self.root.iconphoto(True, tk.PhotoImage(file=icon_path))

        self.selected_date = date.today()
        self.countdown_timer = None
        self.countdown_items = {}  # iid -> deadline
        self._setup_styles()
        self._build_ui()
        self._refresh_upcoming()
        self._start_countdown()

    def _setup_styles(self):
        style = ttk.Style()
        style.theme_use('clam')
        style.configure('TLabel', background='#2b2b2b', foreground='#e0e0e0')
        style.configure('TButton', font=('Helvetica', 11, 'bold'))
        style.configure('Treeview', background='#3b3b3b', fieldbackground='#3b3b3b', foreground='#e0e0e0')
        style.configure('Treeview.Heading', background='#555', foreground='#fff')
        style.map('Treeview', background=[('selected', '#0078d7')])
        style.configure('Overdue.TLabel', foreground='#ff4444', font=('Helvetica', 10, 'bold'))

    def _build_ui(self):
        header = ttk.Frame(self.root)
        header.pack(fill='x', padx=15, pady=10)
        ttk.Label(header, text="Snakedesk", font=('Helvetica', 18, 'bold')).pack(side='left')
        ttk.Button(header, text="Logout", command=self._logout).pack(side='right')
        ttk.Button(header, text="View All Todos", command=self._view_all).pack(side='right', padx=5)

        form = ttk.LabelFrame(self.root, text=" Add New Todo ", padding=12)
        form.pack(fill='x', padx=15, pady=10)

        ttk.Label(form, text="Title *").grid(row=0, column=0, sticky='w', pady=4)
        self.title_var = tk.StringVar()
        ttk.Entry(form, textvariable=self.title_var, width=45).grid(row=0, column=1, padx=8, pady=4)

        ttk.Label(form, text="Description").grid(row=1, column=0, sticky='w', pady=4)
        self.desc_var = tk.StringVar()
        ttk.Entry(form, textvariable=self.desc_var, width=45).grid(row=1, column=1, padx=8, pady=4)

        ttk.Label(form, text="Deadline *").grid(row=2, column=0, sticky='w', pady=4)
        dl_frame = ttk.Frame(form)
        dl_frame.grid(row=2, column=1, sticky='w', padx=8, pady=4)
        self.date_btn = ttk.Button(dl_frame, text=self.selected_date.strftime("%Y-%m-%d"), command=self.pick_date)
        self.date_btn.pack(side='left')
        self.time_var = tk.StringVar(value="12:00")
        ttk.Entry(dl_frame, textvariable=self.time_var, width=6).pack(side='left', padx=(6, 0))

        ttk.Button(form, text="Add Todo", command=self._add_todo).grid(row=3, column=1, pady=12, sticky='e')

        list_frame = ttk.Frame(self.root)
        list_frame.pack(fill='both', expand=True, padx=15, pady=10)

        columns = ("ID", "Title", "Countdown")
        self.tree = ttk.Treeview(list_frame, columns=columns, show='headings', height=12)
        for col, w in zip(columns, [50, 380, 180]):
            self.tree.heading(col, text=col)
            self.tree.column(col, width=w, anchor='center' if col != "Title" else 'w')
        self.tree.pack(side='left', fill='both', expand=True)
        scrollbar = ttk.Scrollbar(list_frame, command=self.tree.yview)
        scrollbar.pack(side='right', fill='y')
        self.tree.configure(yscrollcommand=scrollbar.set)

        ttk.Button(self.root, text="Edit/View Selected", command=self._edit_selected).pack(pady=8)

    def pick_date(self):
        DatePickerDialog(self.root, self.set_date, self.selected_date)

    def set_date(self, selected):
        self.selected_date = selected
        self.date_btn.configure(text=selected.strftime("%Y-%m-%d"))

    def _start_countdown(self):
        if self.countdown_timer:
            self.root.after_cancel(self.countdown_timer)
        self._update_countdowns()
        self._refresh_upcoming()
        self.countdown_timer = self.root.after(2600, self._start_countdown)

    def _update_countdowns(self):
        now = datetime.now()
        for iid, deadline in list(self.countdown_items.items()):
            diff = deadline - now
            if diff.total_seconds() <= 0:
                #self.tree.set(iid, "Countdown", "OVERDUE")
                #self.tree.item(iid, tags=('overdue',))
                self.tree.delete(iid)
                del self.countdown_items[iid]
            else:
                days = diff.days
                hrs, rem = divmod(diff.seconds, 3600)
                mins, _ = divmod(rem, 60)
                self.tree.set(iid, "Countdown", f"{days}d {hrs}h {mins}m")
        self.tree.tag_configure('overdue', foreground='#ff4444', font=('Helvetica', 10, 'bold'))

    def _refresh_upcoming(self):
        for i in self.tree.get_children(): self.tree.delete(i)
        self.countdown_items.clear()

        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("""
                SELECT id, title, deadline FROM todos
                WHERE user_id=%s AND deadline >= NOW()
                ORDER BY deadline ASC LIMIT 7
            """, (self.user_id,))
            rows = cur.fetchall()
            conn.close()
        except Exception as e:
            messagebox.showerror("Error", f"Load failed: {e}")
            return

        for row in rows:
            iid = self.tree.insert("", "end", values=(row[0], row[1], ""))
            self.countdown_items[iid] = row[2]
        self._update_countdowns()

    def _view_all(self):
        win = tk.Toplevel(self.root)
        win.title("All Todos")
        win.configure(bg="#2b2b2b")
        win.geometry("1000x650")
        win.minsize(800, 500)

        # ICON
        icon_path = "snakedesk.png"
        if os.path.exists(icon_path):
            win.iconphoto(True, tk.PhotoImage(file=icon_path))

        tree_frame = ttk.Frame(win)
        tree_frame.pack(fill='both', expand=True, padx=15, pady=15)

        columns = ("ID", "Title", "Deadline", "Status", "Edit")
        tree = ttk.Treeview(tree_frame, columns=columns, show='headings')
        for col, w in zip(columns, [50, 350, 160, 120, 80]):
            tree.heading(col, text=col)
            tree.column(col, width=w, anchor='center' if col != "Title" else 'w')
        tree.pack(side='left', fill='both', expand=True)
        scrollbar = ttk.Scrollbar(tree_frame, command=tree.yview)
        scrollbar.pack(side='right', fill='y')
        tree.configure(yscrollcommand=scrollbar.set)

        # === FIXED: NO window_create, USE CLICKABLE "Edit" TEXT ===
        tree.tag_configure("edit", foreground="blue", font=('', 9, 'underline'))
        tree.bind("<Button-1>", self._handle_edit_click_in_all)

        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("SELECT id, title, deadline FROM todos WHERE user_id=%s ORDER BY deadline", (self.user_id,))
            rows = cur.fetchall()
            conn.close()
        except Exception as e:
            messagebox.showerror("Error", f"DB error: {e}")
            return

        now = datetime.now()
        for row in rows:
            dl_str = row[2].strftime("%Y-%m-%d %H:%M")
            diff = row[2] - now
            status = "OVERDUE" if diff.total_seconds() <= 0 else f"{diff.days}d {diff.seconds//3600}h {(diff.seconds%3600)//60}m"
            tags = ('overdue',) if diff.total_seconds() <= 0 else ()

            iid = str(row[0])
            tree.insert("", "end", iid=iid, values=(row[0], row[1], dl_str, status, "Edit"), tags=tags + ("edit",))

        tree.tag_configure('overdue', foreground='#ff4444', font=('Helvetica', 10, 'bold'))

    def _handle_edit_click_in_all(self, event):
        col = event.widget.identify_column(event.x)
        row = event.widget.identify_row(event.y)
        if col == "#5" and row:
            todo_id = row
            self._edit_from_all(todo_id, event.widget.master.master)

    def _edit_from_all(self, todo_id, win):
        win.destroy()
        self._edit_selected(todo_id)

    def _add_todo(self):
        title = self.title_var.get().strip()
        time_str = self.time_var.get().strip()
        if not title or not time_str:
            messagebox.showerror("Error", "Title and time required")
            return
        try:
            deadline = datetime.combine(self.selected_date, datetime.strptime(time_str, "%H:%M").time())
        except:
            messagebox.showerror("Error", "Invalid time (HH:MM)")
            return

        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("INSERT INTO todos (user_id, title, description, deadline, edit_count) VALUES (%s, %s, %s, %s, 0)",
                        (self.user_id, title, self.desc_var.get().strip(), deadline))
            conn.commit()
            conn.close()
        except Exception as e:
            messagebox.showerror("Error", f"Save failed: {e}")
            return

        self.title_var.set("")
        self.desc_var.set("")
        self.time_var.set("12:00")
        self._refresh_upcoming()

    def _edit_selected(self, force_id=None):
        sel = self.tree.selection()
        todo_id = force_id or (self.tree.item(sel[0])['values'][0] if sel else None)
        if not todo_id: return

        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("SELECT title, description, deadline, edit_count FROM todos WHERE id=%s", (todo_id,))
            row = cur.fetchone()
            conn.close()
        except Exception as e:
            messagebox.showerror("Error", f"DB error: {e}")
            return

        win = tk.Toplevel(self.root)
        win.title("Edit Todo")
        win.configure(bg="#2b2b2b")
        win.geometry("540x360")

        ttk.Label(win, text="Title *").pack(pady=(15, 4))
        title_var = tk.StringVar(value=row[0])
        ttk.Entry(win, textvariable=title_var, width=50).pack(padx=20)

        ttk.Label(win, text="Description").pack(pady=(10, 4))
        desc_var = tk.StringVar(value=row[1])
        ttk.Entry(win, textvariable=desc_var, width=50).pack(padx=20)

        ttk.Label(win, text="Deadline *").pack(pady=(10, 4))
        dl_frame = ttk.Frame(win)
        dl_frame.pack(padx=20, fill='x')

        cur_deadline = row[2]
        edit_date = cur_deadline.date()
        date_btn = ttk.Button(dl_frame, text=edit_date.strftime("%Y-%m-%d"))
        date_btn.pack(side='left')
        if row[3] >= 1:
            date_btn.configure(state='disabled')
        else:
            date_btn.configure(command=lambda: DatePickerDialog(win, lambda d: date_btn.configure(text=d.strftime("%Y-%m-%d")), edit_date))

        time_var = tk.StringVar(value=cur_deadline.strftime("%H:%M"))
        ttk.Entry(dl_frame, textvariable=time_var, width=6).pack(side='left', padx=(6, 0))

        def save():
            new_title = title_var.get().strip()
            if not new_title:
                messagebox.showerror("Error", "Title required")
                return
            try:
                new_deadline = datetime.combine(
                    datetime.strptime(date_btn['text'], "%Y-%m-%d").date(),
                    datetime.strptime(time_var.get(), "%H:%M").time()
                )
            except:
                messagebox.showerror("Error", "Invalid date/time")
                return

            increment = 1 if new_deadline != cur_deadline and row[3] < 1 else 0
            if increment and row[3] >= 1:
                messagebox.showerror("Error", "Deadline can only be edited once.")
                return

            try:
                conn = get_db_connection()
                cur = conn.cursor()
                cur.execute("""
                    UPDATE todos SET title=%s, description=%s, deadline=%s, edit_count=edit_count+%s
                    WHERE id=%s
                """, (new_title, desc_var.get().strip(), new_deadline, increment, todo_id))
                conn.commit()
                conn.close()
                win.destroy()
                self._refresh_upcoming()
            except Exception as e:
                messagebox.showerror("Error", f"Save failed: {e}")

        ttk.Button(win, text="Save Changes", command=save).pack(pady=20)

    def _logout(self):
        if messagebox.askyesno("Logout", "Log out?"):
            if self.countdown_timer:
                self.root.after_cancel(self.countdown_timer)
            self.root.destroy()
            start_auth()

    def run(self):
        self.root.mainloop()

# --------------------------------------------------------------
# START
# --------------------------------------------------------------
def start_auth():
    root = tk.Tk()
    AuthApp(root)
    root.mainloop()

if __name__ == "__main__":
    start_auth()
