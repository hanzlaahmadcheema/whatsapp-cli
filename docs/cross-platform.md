# Cross-Platform Installation & Troubleshooting Guide

This guide covers installing, configuring, and operating **WhatsApp CLI**, the background daemon, and the **MCP Server** across **Linux**, **macOS**, and **Windows 10/11**.

---

## Platform Support Matrix

| Component | Linux (Ubuntu/Fedora/Arch) | macOS (Intel & Apple Silicon) | Windows 10 / 11 (PowerShell/CMD) |
| :--- | :---: | :---: | :---: |
| **CLI Frontend (`wa`)** | Full | Full | Full |
| **Terminal UI (`wa tui`)** | Full | Full | Full (Windows Terminal) |
| **Background Daemon (`wa daemon`)** | Full | Full | Full |
| **MCP Server (`wa mcp`)** | Full | Full | Full |
| **Media Sending (Photos & Docs)** | Full | Full | Full |
| **System Tray Manager (`wa tray`)** | Full (StatusNotifierItem) | N/A (Linux-only) | N/A (Linux-only) |
| **Suspend/Resume Recovery (`DBus`)** | Full (systemd-logind) | Fallback Heartbeat | Fallback Heartbeat |
| **Autostart Service** | Systemd User Unit | launchd plist (manual) | Task Scheduler / Startup |

> [!NOTE]
> The Core CLI, Background Daemon, and MCP Server are 100% cross-platform Node.js (v18+). The system tray manager uses the FreeDesktop StatusNotifierItem standard and is specific to Linux desktops.

---

## Linux Installation (Ubuntu, Debian, Fedora, Arch)

### 1. Prerequisites
- **Node.js**: >= 18.0.0 (check with `node -v`)
- **Git**: (check with `git --version`)
- **System Chromium Dependencies**: For headless browser rendering:
  ```bash
  # Ubuntu / Debian
  sudo apt update && sudo apt install -y \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2t64 libpango-1.0-0

  # Fedora
  sudo dnf install -y nss atk cups-libs libdrm libxkbcommon \
    libXcomposite libXdamage libXfixes libXrandr mesa-libgbm alsa-lib pango

  # Arch Linux
  sudo pacman -S --needed nss atk cups libdrm libxkbcommon \
    libxcomposite libxdamage libxfixes libxrandr mesa alsa-lib pango
  ```
- *(Optional - for system tray manager only)*: Python 3 and PyGObject / Ayatana:
  ```bash
  # Ubuntu / Debian
  sudo apt install -y python3 python3-gi gir1.2-ayatanaappindicator3-0.1 gir1.2-gtk-3.0

  # Fedora
  sudo dnf install -y python3-gobject libappindicator-gtk3

  # Arch Linux
  sudo pacman -S --needed python-gobject libayatana-appindicator gtk3
  ```

### 2. Clone & Install
```bash
git clone https://github.com/hanzlaahmadcheema/whatsapp-cli.git
cd whatsapp-cli

# Install dependencies (automatically runs postinstall patch)
npm install

# Expose 'wa' globally
npm link
```

### 3. Authenticate & Link WhatsApp
```bash
wa login
```
Scan the terminal QR code using WhatsApp on your phone (**Linked Devices** > **Link a device**). Once authenticated, the CLI prints:
```text
✔ Linked and authenticated as User Name (15551234567). Daemon is ready.
```

### 4. Daemon Operation
```bash
# Check daemon health & account
wa status

# Start daemon in background (auto-starts on first CLI command)
wa daemon

# Full-screen terminal dashboard
wa tui

# Enable Linux login autostart
wa autostart enable
```

---

## macOS Installation (Intel & Apple Silicon)

### 1. Prerequisites
- **Node.js**: >= 18.0.0 (recommended via Homebrew: `brew install node`)
- **Git**: (included with Xcode Command Line Tools: `xcode-select --install`)

### 2. Clone & Install
```bash
git clone https://github.com/hanzlaahmadcheema/whatsapp-cli.git
cd whatsapp-cli

npm install
npm link
```

### 3. Authenticate
```bash
wa login
```
Scan the QR code displayed in iTerm2, Terminal.app, or Kitty.

### 4. Background Daemon on macOS
The daemon will automatically launch on demand when any CLI or MCP command is run. If you prefer to launch it manually in the background:
```bash
wa daemon
```
To keep the daemon running on macOS login, you can create a launchd agent:
```xml
<!-- ~/Library/LaunchAgents/com.whatsapp.cli.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.whatsapp.cli</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/username/whatsapp-cli/src/daemon/index.js</string>
        <string>--foreground</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

---

## Windows 10 & 11 Installation (PowerShell & Command Prompt)

### 1. Prerequisites
- **Node.js**: >= 18.0.0 (download from [nodejs.org](https://nodejs.org/) or install via `winget install OpenJS.NodeJS.LTS`)
- **Git**: (install via `winget install Git.Git`)
- **Windows Terminal**: Recommended for proper Unicode emoji and ANSI color support.

### 2. Clone & Install (PowerShell)
Open PowerShell (as Administrator if needed for `npm link`):
```powershell
git clone https://github.com/hanzlaahmadcheema/whatsapp-cli.git
cd whatsapp-cli

npm install
npm link
```

> [!TIP]
> If PowerShell blocks `wa` execution with a script policy error (`running scripts is disabled on this system`), enable local script execution:
> ```powershell
> Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```

### 3. Authenticate
```powershell
wa login
```
Scan the ASCII QR code with your mobile device.

### 4. MCP Server Configuration on Windows
When connecting Windows AI agents (Claude Desktop, Cursor, OpenBot) to the MCP server, configure your MCP JSON with `cmd.exe`:
```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "cmd.exe",
      "args": ["/c", "wa", "mcp"]
    }
  }
}
```
Or point directly to `node.exe`:
```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node.exe",
      "args": ["C:\\Users\\YourUsername\\whatsapp-cli\\src\\mcp\\index.js"]
    }
  }
}
```

---

## Troubleshooting Guide

### 1. Chromium / Puppeteer Sandboxing Issues (Linux)
**Symptom:** Daemon fails to launch with `Running as root without --no-sandbox is not supported` or `Failed to launch the browser process`.
**Fix:**
Ensure system Chromium libraries are installed (see Linux prerequisites). If running inside Docker, WSL, or an unprivileged container:
```bash
export PUPPETEER_ARGS="--no-sandbox,--disable-setuid-sandbox"
wa daemon
```

### 2. Terminal QR Code Display Issues
**Symptom:** The QR code renders inverted or cannot be scanned by the phone camera.
**Fix:**
- Most terminal themes (dark vs light background) require inverted rendering. `qrcode-terminal` automatically outputs small blocks. If your terminal background is white/light, switch your terminal profile to a dark background or zoom in slightly (`Ctrl + +`).
- You can also view status and QR events programmatically via `wa status` or SSE streaming.

### 3. Port Conflicts or Stale Daemon PID
**Symptom:** `Address already in use` or CLI reports `Daemon is not ready` repeatedly.
**Fix:**
1. Stop any zombie processes:
   ```bash
   wa stop
   ```
2. If the PID file is stale, remove it:
   ```bash
   # Linux / macOS
   rm -f .data/daemon.json

   # Windows (PowerShell)
   Remove-Item .data\daemon.json -Force
   ```
3. Restart the daemon:
   ```bash
   wa daemon
   ```

### 4. Session Invalidation / Phone Logged Out
**Symptom:** `wa status` reports `State: logged_out` or `Session unlinked`.
**Fix:**
If you unlinked the device from your WhatsApp mobile app, simply re-authenticate:
```bash
wa login
```
This will generate a fresh QR code and re-establish local session credentials.

### 5. Media Sending Memoization Error (`Data passed to getter must include an id property`)
**Symptom:** Sending photos or documents returns a getter error from WhatsApp Web internal scripts.
**Fix:**
Run the repository patch script:
```bash
npm run patch
```
This updates `whatsapp-web.js` injected utilities with idempotent compatibility patches for WhatsApp Web 2026 builds.

---

## Uninstallation

To remove WhatsApp CLI from your system:

### 1. Unlink Session & Stop Daemon
```bash
wa logout
wa stop
```

### 2. Disable Linux Autostart Services
```bash
wa autostart disable
```

### 3. Remove Global Link & Delete Directory
```bash
# In the repository directory:
npm unlink

# Remove the directory and local credentials:
cd ..
rm -rf whatsapp-cli

# On Windows:
# Remove-Item -Recurse -Force whatsapp-cli
```
All credentials stored in `.wwebjs_auth` are erased with the directory deletion.
