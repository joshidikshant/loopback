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
# check your node path first: which node
launchctl load ~/Library/LaunchAgents/dev.loopback.hub.plist
tail -f /tmp/loopback-hub.log
```

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
