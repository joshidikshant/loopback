# Keeping the central Loopback instance alive

Widgets need one long-running `--http` instance (stdio spawns work for agents
regardless — same DB, same queue). Pick whichever supervisor you already use.

## pm2 (any OS)

```bash
npm install -g pm2
pm2 start "loopback-mcp-server --http" --name loopback
# or from a checkout: pm2 start /ABS/PATH/loopback/dist/index.js --name loopback -- --http
pm2 save && pm2 startup   # follow the printed command to persist across reboots
pm2 logs loopback
```

## launchd (macOS)

`~/Library/LaunchAgents/dev.loopback.hub.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.loopback.hub</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/ABS/PATH/loopback/dist/index.js</string>
    <string>--http</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/loopback-hub.log</string>
</dict></plist>
```

```bash
# The node path above is a PLACEHOLDER and is wrong on most machines — launchd
# does no PATH lookup, so a wrong path fails silently with no hub and no error.
# Get yours first and paste it in:
which node          # e.g. /Users/you/.nvm/versions/node/v22.21.1/bin/node

launchctl load ~/Library/LaunchAgents/dev.loopback.hub.plist
launchctl list | grep loopback     # should show a pid
curl -s http://127.0.0.1:7077/health
tail -f /tmp/loopback-hub.log
```

**nvm users:** the path embeds the node version, so `nvm install <newer>` breaks
it. Update the plist and `launchctl unload && launchctl load` after upgrading.

## systemd (Linux)

`~/.config/systemd/user/loopback.service`:

```ini
[Unit]
Description=Loopback feedback hub

[Service]
ExecStart=/usr/bin/node /ABS/PATH/loopback/dist/index.js --http
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now loopback
journalctl --user -u loopback -f
```

## Verify

```bash
curl http://127.0.0.1:7077/health
open http://127.0.0.1:7077/queue
```
