#!/usr/bin/env python3
"""
WhatsApp CLI — Linux System Tray Manager (StatusNotifierItem / AyatanaAppIndicator)
Supports Hyprland, Quickshell, Waybar, GNOME, KDE.
"""

import os
import sys
import json
import time
import signal
import threading
import subprocess
import urllib.request
import urllib.error

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("AyatanaAppIndicator3", "0.1")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gtk, AyatanaAppIndicator3 as appindicator, GLib, GdkPixbuf

# Repository and assets paths
REPO_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ASSETS_DIR = os.path.join(REPO_DIR, "assets", "tray")
DATA_DIR = os.path.join(REPO_DIR, ".data")
DAEMON_FILE = os.path.join(DATA_DIR, "daemon.json")
CONFIG_DIR = os.path.expanduser("~/.config/whatsapp-cli")
SETTINGS_FILE = os.path.join(CONFIG_DIR, "settings.json")
SYSTEMD_USER_DIR = os.path.expanduser("~/.config/systemd/user")

ICONS = {
    "ready": os.path.join(ASSETS_DIR, "ready.svg"),
    "connecting": os.path.join(ASSETS_DIR, "connecting.svg"),
    "recovering": os.path.join(ASSETS_DIR, "recovering.svg"),
    "error": os.path.join(ASSETS_DIR, "error.svg"),
    "offline": os.path.join(ASSETS_DIR, "offline.svg"),
}

DEFAULT_SETTINGS = {
    "launchTrayOnLogin": False,
    "autoStartDaemon": True,
    "autoReconnectOnResume": True,
    "maxRecoveryAttempts": 3,
    "retryBackoffBaseMs": 2000,
    "notifications": {
        "enabled": True,
        "cooldownMs": 10000,
    },
}


def load_settings():
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                res = dict(DEFAULT_SETTINGS)
                res.update(data)
                return res
    except Exception:
        pass
    return dict(DEFAULT_SETTINGS)


def save_settings(data):
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"Error saving settings: {e}", file=sys.stderr)


class WhatsAppTrayManager:
    def __init__(self):
        self.state = "offline"
        self.account_info = None
        self.last_error = None
        self.last_connected_time = None
        self.daemon_info = None
        self.running = True
        self.sse_thread = None
        self.last_notification_time = {}
        self.settings = load_settings()

        # Build StatusNotifierItem Indicator
        self.indicator = appindicator.Indicator.new(
            "whatsapp-tray-manager",
            ICONS["offline"],
            appindicator.IndicatorCategory.APPLICATION_STATUS,
        )
        self.indicator.set_status(appindicator.IndicatorStatus.ACTIVE)
        self.indicator.set_title("WhatsApp")

        self.build_menu()
        self.update_ui_state("offline", None, None)

        # Write tray PID
        os.makedirs(DATA_DIR, exist_ok=True)
        self.tray_pid_file = os.path.join(DATA_DIR, "tray.pid")
        try:
            with open(self.tray_pid_file, "w", encoding="utf-8") as f:
                f.write(str(os.getpid()))
        except Exception:
            pass

        # Start background polling timer
        GLib.timeout_add_seconds(3, self.poll_daemon)
        # Initial poll
        GLib.idle_add(self.poll_daemon)

    def build_menu(self):
        self.menu = Gtk.Menu()

        # Status row
        self.item_status = Gtk.MenuItem(label="Status: Offline")
        self.item_status.set_sensitive(False)
        self.menu.append(self.item_status)

        # Account row
        self.item_account = Gtk.MenuItem(label="Account: None")
        self.item_account.set_sensitive(False)
        self.menu.append(self.item_account)

        # Last Error row
        self.item_error = Gtk.MenuItem(label="Error: None")
        self.item_error.set_sensitive(False)
        self.item_error.set_visible(False)
        self.menu.append(self.item_error)

        # Last connected time row
        self.item_time = Gtk.MenuItem(label="Connected: Never")
        self.item_time.set_sensitive(False)
        self.item_time.set_visible(False)
        self.menu.append(self.item_time)

        self.menu.append(Gtk.SeparatorMenuItem())

        # Actions: View Chats & View Recent
        self.item_chats = Gtk.MenuItem(label="View Chats")
        self.item_chats.connect("activate", self.on_view_chats)
        self.menu.append(self.item_chats)

        self.item_recent = Gtk.MenuItem(label="View Recent Messages")
        self.item_recent.connect("activate", self.on_view_recent)
        self.menu.append(self.item_recent)

        # Reconnect
        self.item_reconnect = Gtk.MenuItem(label="Reconnect")
        self.item_reconnect.connect("activate", self.on_reconnect)
        self.menu.append(self.item_reconnect)

        self.menu.append(Gtk.SeparatorMenuItem())

        # Daemon controls
        self.item_start = Gtk.MenuItem(label="Start Daemon")
        self.item_start.connect("activate", self.on_start_daemon)
        self.menu.append(self.item_start)

        self.item_stop = Gtk.MenuItem(label="Stop Daemon")
        self.item_stop.connect("activate", self.on_stop_daemon)
        self.menu.append(self.item_stop)

        self.item_restart = Gtk.MenuItem(label="Restart Daemon")
        self.item_restart.connect("activate", self.on_restart_daemon)
        self.menu.append(self.item_restart)

        self.item_logs = Gtk.MenuItem(label="Open Daemon Logs")
        self.item_logs.connect("activate", self.on_open_logs)
        self.menu.append(self.item_logs)

        self.menu.append(Gtk.SeparatorMenuItem())

        # Settings & Quit
        self.item_settings = Gtk.MenuItem(label="Settings")
        self.item_settings.connect("activate", self.on_open_settings)
        self.menu.append(self.item_settings)

        self.item_quit = Gtk.MenuItem(label="Quit Tray Manager")
        self.item_quit.connect("activate", self.on_quit)
        self.menu.append(self.item_quit)

        self.menu.show_all()
        self.indicator.set_menu(self.menu)

    def read_daemon_file(self):
        if not os.path.exists(DAEMON_FILE):
            return None
        try:
            with open(DAEMON_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            pid = data.get("pid")
            if pid:
                # Check if PID is alive
                os.kill(pid, 0)
                return data
        except Exception:
            return None
        return None

    def poll_daemon(self):
        prev_info = self.daemon_info
        info = self.read_daemon_file()
        self.daemon_info = info

        if not info:
            if self.state != "offline":
                self.notify("Connection lost", "WhatsApp daemon is stopped.")
            self.update_ui_state("offline", None, self.last_error)
            return True

        # Query HTTP status
        host = info.get("host") or "127.0.0.1"
        port = info.get("port")
        token = info.get("token")
        if not port or not token:
            self.update_ui_state("offline", None, None)
            return True

        try:
            req = urllib.request.Request(
                f"http://{host}:{port}/status",
                headers={"x-wa-token": token},
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=2.5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if data.get("ok"):
                    state = data.get("state", "connecting")
                    account = data.get("account")
                    err = data.get("lastError")
                    self.update_ui_state(state, account, err)
        except Exception as e:
            # Daemon process is up but HTTP not responding yet
            self.update_ui_state("connecting", None, f"Connecting to daemon: {e}")

        # Ensure SSE listener is active if daemon is alive
        if not self.sse_thread or not self.sse_thread.is_alive():
            self.start_sse_listener(host, port, token)

        return True

    def start_sse_listener(self, host, port, token):
        self.sse_thread = threading.Thread(
            target=self._run_sse,
            args=(host, port, token),
            daemon=True,
        )
        self.sse_thread.start()

    def _run_sse(self, host, port, token):
        url = f"http://{host}:{port}/receive"
        req = urllib.request.Request(url, headers={"x-wa-token": token})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                buffer = ""
                for raw_line in resp:
                    if not self.running:
                        break
                    line = raw_line.decode("utf-8", errors="ignore").strip()
                    if line.startswith("data:"):
                        payload = line[5:].strip()
                        try:
                            evt = json.loads(payload)
                            GLib.idle_add(self.handle_sse_event, evt)
                        except Exception:
                            pass
        except Exception:
            pass

    def handle_sse_event(self, evt):
        name = evt.get("event")
        if name == "state":
            st = evt.get("state", self.state)
            reason = evt.get("reason")
            self.update_ui_state(st, self.account_info, self.last_error)
            if reason == "reconnecting":
                self.notify("Reconnecting", "WhatsApp session is reconnecting…")
        elif name == "ready":
            self.update_ui_state("ready", self.account_info, None)
            self.notify("WhatsApp Connected", "WhatsApp is ready and operational.")
        elif name == "recovery_success":
            self.update_ui_state("ready", self.account_info, None)
            self.notify("Recovery Successful", "WhatsApp session recovered successfully.")
        elif name == "recovery_failed":
            err = evt.get("error", "Recovery attempts exhausted")
            self.update_ui_state("error", self.account_info, err)
            self.notify("Recovery Failed", f"Could not recover WhatsApp: {err}")
        elif name == "sleep":
            self.update_ui_state("connecting", self.account_info, "System suspended")
        elif name == "resume":
            self.update_ui_state("connecting", self.account_info, "System resumed — reconnecting…")
        elif name == "error":
            err = evt.get("message", "Unknown error")
            self.update_ui_state("error", self.account_info, err)
            self.notify("WhatsApp Error", err)

    def update_ui_state(self, state, account, error):
        old_state = self.state
        self.state = state
        self.account_info = account
        if error:
            self.last_error = error
        elif state == "ready":
            self.last_error = None
            if not self.last_connected_time:
                self.last_connected_time = time.strftime("%H:%M:%S")

        # Map state to icon
        icon_name = "offline"
        if state == "ready":
            icon_name = "ready"
        elif state in ("connecting", "linking", "syncing"):
            icon_name = "connecting"
        elif state == "recovering":
            icon_name = "recovering"
        elif state in ("error", "logged_out"):
            icon_name = "error"
        elif state == "offline":
            icon_name = "offline"

        icon_path = ICONS.get(icon_name, ICONS["offline"])
        self.indicator.set_icon_full(icon_path, f"WhatsApp: {state.capitalize()}")

        # Update menu items
        state_label = state.capitalize()
        if state == "recovering":
            state_label = "Recovering…"
        elif state in ("connecting", "syncing"):
            state_label = "Connecting…"

        self.item_status.set_label(f"Status: {state_label}")

        # Account info
        if account and isinstance(account, dict):
            name = account.get("pushname") or account.get("name") or "Connected"
            number = account.get("number") or ""
            acct_str = f"{name} (+{number})" if number else name
            self.item_account.set_label(f"Account: {acct_str}")
            self.item_account.set_visible(True)
        else:
            self.item_account.set_label("Account: None")
            self.item_account.set_visible(state != "offline")

        # Error
        if self.last_error:
            # Truncate if long
            err_disp = self.last_error if len(self.last_error) <= 35 else self.last_error[:32] + "…"
            self.item_error.set_label(f"Error: {err_disp}")
            self.item_error.set_visible(True)
        else:
            self.item_error.set_visible(False)

        # Connected time
        if self.last_connected_time and state == "ready":
            self.item_time.set_label(f"Connected: {self.last_connected_time}")
            self.item_time.set_visible(True)
        else:
            self.item_time.set_visible(False)

        # Sensitivity rules
        is_ready = (state == "ready")
        is_online = (state != "offline")

        self.item_chats.set_sensitive(is_ready)
        self.item_recent.set_sensitive(is_ready)
        self.item_reconnect.set_sensitive(is_online)
        self.item_start.set_sensitive(not is_online)
        self.item_stop.set_sensitive(is_online)
        self.item_restart.set_sensitive(is_online)

    def notify(self, title, message):
        self.settings = load_settings()
        notif_cfg = self.settings.get("notifications", {})
        if not notif_cfg.get("enabled", True):
            return

        cooldown = notif_cfg.get("cooldownMs", 10000) / 1000.0
        now = time.time()
        last = self.last_notification_time.get(title, 0)
        if now - last < cooldown:
            return
        self.last_notification_time[title] = now

        icon_path = ICONS.get(self.state, ICONS["offline"])
        try:
            subprocess.run(
                ["notify-send", "-a", "WhatsApp", "-i", icon_path, title, message],
                timeout=3,
                check=False,
            )
        except Exception:
            pass

    # ---- Actions ----

    def on_reconnect(self, widget):
        if not self.daemon_info:
            return
        host = self.daemon_info.get("host") or "127.0.0.1"
        port = self.daemon_info.get("port")
        token = self.daemon_info.get("token")
        self.item_reconnect.set_label("Reconnecting…")
        self.item_reconnect.set_sensitive(False)

        def do_call():
            try:
                req = urllib.request.Request(
                    f"http://{host}:{port}/reconnect",
                    data=b"{}",
                    headers={"x-wa-token": token, "content-type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=45) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    GLib.idle_add(self._reconnect_done, True, None)
            except Exception as e:
                GLib.idle_add(self._reconnect_done, False, str(e))

        threading.Thread(target=do_call, daemon=True).start()

    def _reconnect_done(self, success, err):
        self.item_reconnect.set_label("Reconnect")
        self.item_reconnect.set_sensitive(True)
        if not success:
            self.notify("Reconnect Failed", err or "Unknown error")

    def on_start_daemon(self, widget):
        self.item_start.set_label("Starting…")
        self.item_start.set_sensitive(False)

        def do_start():
            try:
                wa_bin = os.path.join(REPO_DIR, "bin", "wa.js")
                subprocess.run(
                    ["node", wa_bin, "daemon", "--detach"],
                    cwd=REPO_DIR,
                    timeout=10,
                    check=False,
                )
            except Exception as e:
                print(f"Error starting daemon: {e}", file=sys.stderr)
            GLib.idle_add(self._start_daemon_done)

        threading.Thread(target=do_start, daemon=True).start()

    def _start_daemon_done(self):
        self.item_start.set_label("Start Daemon")
        self.poll_daemon()

    def on_stop_daemon(self, widget):
        self.item_stop.set_label("Stopping…")
        self.item_stop.set_sensitive(False)

        def do_stop():
            try:
                wa_bin = os.path.join(REPO_DIR, "bin", "wa.js")
                subprocess.run(
                    ["node", wa_bin, "stop"],
                    cwd=REPO_DIR,
                    timeout=10,
                    check=False,
                )
            except Exception as e:
                print(f"Error stopping daemon: {e}", file=sys.stderr)
            GLib.idle_add(self._stop_daemon_done)

        threading.Thread(target=do_stop, daemon=True).start()

    def _stop_daemon_done(self):
        self.item_stop.set_label("Stop Daemon")
        self.poll_daemon()

    def on_restart_daemon(self, widget):
        self.item_restart.set_label("Restarting…")
        self.item_restart.set_sensitive(False)

        def do_restart():
            try:
                wa_bin = os.path.join(REPO_DIR, "bin", "wa.js")
                subprocess.run(["node", wa_bin, "stop"], cwd=REPO_DIR, timeout=10, check=False)
                time.sleep(1)
                subprocess.run(["node", wa_bin, "daemon", "--detach"], cwd=REPO_DIR, timeout=10, check=False)
            except Exception as e:
                print(f"Error restarting daemon: {e}", file=sys.stderr)
            GLib.idle_add(self._restart_daemon_done)

        threading.Thread(target=do_restart, daemon=True).start()

    def _restart_daemon_done(self):
        self.item_restart.set_label("Restart Daemon")
        self.poll_daemon()

    def on_open_logs(self, widget):
        log_file = self.settings.get("logFile") or os.path.expanduser("~/.local/state/whatsapp-cli/daemon.log")
        if not os.path.exists(log_file):
            os.makedirs(os.path.dirname(log_file), exist_ok=True)
            with open(log_file, "a", encoding="utf-8") as f:
                f.write("# WhatsApp CLI Daemon Log\n")
        try:
            subprocess.Popen(["xdg-open", log_file])
        except Exception:
            pass

    def on_view_chats(self, widget):
        if not self.daemon_info or self.state != "ready":
            return
        host = self.daemon_info.get("host") or "127.0.0.1"
        port = self.daemon_info.get("port")
        token = self.daemon_info.get("token")

        dialog = Gtk.Dialog(
            title="WhatsApp — Active Chats",
            flags=Gtk.DialogFlags.MODAL | Gtk.DialogFlags.DESTROY_WITH_PARENT,
        )
        dialog.set_default_size(480, 500)
        dialog.add_button("Close", Gtk.ResponseType.CLOSE)

        box = dialog.get_content_area()
        box.set_spacing(8)
        box.set_border_width(12)

        header_lbl = Gtk.Label(label="<b>Recent WhatsApp Chats</b>", use_markup=True)
        header_lbl.set_xalign(0)
        box.pack_start(header_lbl, False, False, 0)

        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        box.pack_start(scrolled, True, True, 0)

        list_box = Gtk.ListBox()
        list_box.set_selection_mode(Gtk.SelectionMode.NONE)
        scrolled.add(list_box)

        # Loading label
        loading_lbl = Gtk.Label(label="Loading chats…")
        list_box.add(loading_lbl)
        dialog.show_all()

        def fetch_chats():
            try:
                req = urllib.request.Request(
                    f"http://{host}:{port}/chats?limit=40",
                    headers={"x-wa-token": token},
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    chats = (data.get("chats") or []) if data.get("ok") else []
                    GLib.idle_add(populate_chats, chats)
            except Exception as e:
                GLib.idle_add(populate_error, str(e))

        def populate_chats(chats):
            for child in list_box.get_children():
                list_box.remove(child)
            if not chats:
                list_box.add(Gtk.Label(label="No active chats found."))
            else:
                for c in chats:
                    row = Gtk.ListBoxRow()
                    hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
                    hbox.set_border_width(8)

                    vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
                    name = c.get("name") or c.get("id") or "Unknown"
                    title_lbl = Gtk.Label(label=f"<b>{GLib.markup_escape_text(name)}</b>", use_markup=True)
                    title_lbl.set_xalign(0)
                    vbox.pack_start(title_lbl, False, False, 0)

                    sub_text = c.get("id", "")
                    unread = c.get("unreadCount", 0)
                    if unread > 0:
                        sub_text += f" • {unread} unread"
                    sub_lbl = Gtk.Label(label=f"<small>{GLib.markup_escape_text(sub_text)}</small>", use_markup=True)
                    sub_lbl.set_xalign(0)
                    vbox.pack_start(sub_lbl, False, False, 0)

                    hbox.pack_start(vbox, True, True, 0)
                    row.add(hbox)
                    list_box.add(row)
            list_box.show_all()

        def populate_error(err_msg):
            for child in list_box.get_children():
                list_box.remove(child)
            list_box.add(Gtk.Label(label=f"Error loading chats: {err_msg}"))
            list_box.show_all()

        threading.Thread(target=fetch_chats, daemon=True).start()
        dialog.run()
        dialog.destroy()

    def on_view_recent(self, widget):
        if not self.daemon_info or self.state != "ready":
            return
        host = self.daemon_info.get("host") or "127.0.0.1"
        port = self.daemon_info.get("port")
        token = self.daemon_info.get("token")

        dialog = Gtk.Dialog(
            title="WhatsApp — Recent Messages",
            flags=Gtk.DialogFlags.MODAL | Gtk.DialogFlags.DESTROY_WITH_PARENT,
        )
        dialog.set_default_size(500, 450)
        dialog.add_button("Close", Gtk.ResponseType.CLOSE)

        box = dialog.get_content_area()
        box.set_spacing(8)
        box.set_border_width(12)

        header_lbl = Gtk.Label(label="<b>Recent Messages</b>", use_markup=True)
        header_lbl.set_xalign(0)
        box.pack_start(header_lbl, False, False, 0)

        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        box.pack_start(scrolled, True, True, 0)

        list_box = Gtk.ListBox()
        list_box.set_selection_mode(Gtk.SelectionMode.NONE)
        scrolled.add(list_box)

        loading_lbl = Gtk.Label(label="Loading recent messages…")
        list_box.add(loading_lbl)
        dialog.show_all()

        def fetch_recent():
            # Get first chat and fetch its history
            try:
                req = urllib.request.Request(
                    f"http://{host}:{port}/chats?limit=5",
                    headers={"x-wa-token": token},
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    chats = (data.get("chats") or []) if data.get("ok") else []
                    if chats:
                        first_id = chats[0].get("id")
                        hreq = urllib.request.Request(
                            f"http://{host}:{port}/history?chatId={urllib.parse.quote(first_id)}&limit=15",
                            headers={"x-wa-token": token},
                        )
                        with urllib.request.urlopen(hreq, timeout=10) as hresp:
                            hdata = json.loads(hresp.read().decode("utf-8"))
                            messages = (hdata.get("messages") or []) if hdata.get("ok") else []
                            GLib.idle_add(populate_messages, chats[0].get("name", first_id), messages)
                    else:
                        GLib.idle_add(populate_empty)
            except Exception as e:
                GLib.idle_add(populate_error, str(e))

        def populate_messages(chat_name, messages):
            for child in list_box.get_children():
                list_box.remove(child)
            header = Gtk.Label(label=f"<small>Showing chat: <b>{GLib.markup_escape_text(chat_name)}</b></small>", use_markup=True)
            header.set_xalign(0)
            list_box.add(header)

            if not messages:
                list_box.add(Gtk.Label(label="No messages found in this chat."))
            else:
                for m in messages:
                    row = Gtk.ListBoxRow()
                    vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
                    vbox.set_border_width(6)

                    author = m.get("author") or m.get("from") or "Unknown"
                    body = m.get("body") or "[Media / Non-text message]"
                    ts = m.get("timestamp")
                    time_str = time.strftime("%H:%M:%S", time.localtime(ts)) if ts else ""

                    top_lbl = Gtk.Label(label=f"<b>{GLib.markup_escape_text(author)}</b> <small>{time_str}</small>", use_markup=True)
                    top_lbl.set_xalign(0)
                    vbox.pack_start(top_lbl, False, False, 0)

                    body_lbl = Gtk.Label(label=GLib.markup_escape_text(body))
                    body_lbl.set_line_wrap(True)
                    body_lbl.set_xalign(0)
                    vbox.pack_start(body_lbl, False, False, 0)

                    row.add(vbox)
                    list_box.add(row)
            list_box.show_all()

        def populate_empty():
            for child in list_box.get_children():
                list_box.remove(child)
            list_box.add(Gtk.Label(label="No messages found."))
            list_box.show_all()

        def populate_error(err_msg):
            for child in list_box.get_children():
                list_box.remove(child)
            list_box.add(Gtk.Label(label=f"Error loading messages: {err_msg}"))
            list_box.show_all()

        threading.Thread(target=fetch_recent, daemon=True).start()
        dialog.run()
        dialog.destroy()

    def on_open_settings(self, widget):
        self.settings = load_settings()
        dialog = Gtk.Dialog(
            title="WhatsApp Tray Settings",
            flags=Gtk.DialogFlags.MODAL | Gtk.DialogFlags.DESTROY_WITH_PARENT,
        )
        dialog.set_default_size(440, 360)
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dialog.add_button("Save", Gtk.ResponseType.OK)

        box = dialog.get_content_area()
        box.set_spacing(12)
        box.set_border_width(14)

        title = Gtk.Label(label="<b>Preferences & Autostart</b>", use_markup=True)
        title.set_xalign(0)
        box.pack_start(title, False, False, 0)

        # Launch on login
        chk_launch = Gtk.CheckButton(label="Launch Tray Manager on Login")
        chk_launch.set_active(self.settings.get("launchTrayOnLogin", False))
        box.pack_start(chk_launch, False, False, 0)

        # Auto-start daemon
        chk_autostart = Gtk.CheckButton(label="Automatically start WhatsApp Daemon")
        chk_autostart.set_active(self.settings.get("autoStartDaemon", True))
        box.pack_start(chk_autostart, False, False, 0)

        # Auto-reconnect on resume
        chk_resume = Gtk.CheckButton(label="Automatically reconnect after laptop sleep/wake")
        chk_resume.set_active(self.settings.get("autoReconnectOnResume", True))
        box.pack_start(chk_resume, False, False, 0)

        # Desktop notifications
        notif_cfg = self.settings.get("notifications", {})
        chk_notif = Gtk.CheckButton(label="Enable Desktop Notifications")
        chk_notif.set_active(notif_cfg.get("enabled", True))
        box.pack_start(chk_notif, False, False, 0)

        box.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 4)

        # Max recovery attempts
        hbox_att = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        lbl_att = Gtk.Label(label="Max Recovery Attempts:")
        lbl_att.set_xalign(0)
        hbox_att.pack_start(lbl_att, True, True, 0)

        adj = Gtk.Adjustment(
            value=self.settings.get("maxRecoveryAttempts", 3),
            lower=1,
            upper=10,
            step_increment=1,
            page_increment=1,
        )
        spin_att = Gtk.SpinButton(adjustment=adj, climb_rate=1, digits=0)
        hbox_att.pack_start(spin_att, False, False, 0)
        box.pack_start(hbox_att, False, False, 0)

        dialog.show_all()
        response = dialog.run()

        if response == Gtk.ResponseType.OK:
            self.settings["launchTrayOnLogin"] = chk_launch.get_active()
            self.settings["autoStartDaemon"] = chk_autostart.get_active()
            self.settings["autoReconnectOnResume"] = chk_resume.get_active()
            self.settings["notifications"]["enabled"] = chk_notif.get_active()
            self.settings["maxRecoveryAttempts"] = int(spin_att.get_value())
            save_settings(self.settings)

            # Apply systemd user autostart if toggled
            self._sync_systemd_autostart(self.settings["launchTrayOnLogin"])

        dialog.destroy()

    def _sync_systemd_autostart(self, enable):
        try:
            wa_bin = os.path.join(REPO_DIR, "bin", "wa.js")
            action = "enable" if enable else "disable"
            subprocess.run(
                ["node", wa_bin, "autostart", action],
                cwd=REPO_DIR,
                timeout=5,
                check=False,
            )
        except Exception:
            pass

    def on_quit(self, widget):
        self.running = False
        try:
            if os.path.exists(self.tray_pid_file):
                os.remove(self.tray_pid_file)
        except Exception:
            pass
        Gtk.main_quit()


def main():
    # Handle SIGINT and SIGTERM gracefully
    signal.signal(signal.SIGINT, lambda s, f: Gtk.main_quit())
    signal.signal(signal.SIGTERM, lambda s, f: Gtk.main_quit())

    manager = WhatsAppTrayManager()
    Gtk.main()


if __name__ == "__main__":
    main()
