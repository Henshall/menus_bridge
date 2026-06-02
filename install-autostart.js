#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync } = require('child_process');

const bridgePath = path.resolve(__dirname, 'index.js');
const platform   = process.platform;

function installWindows() {
    const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Actions>
    <Exec>
      <Command>node</Command>
      <Arguments>"${bridgePath}"</Arguments>
    </Exec>
  </Actions>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
  </Settings>
</Task>`;
    const tmpXml = path.join(os.tmpdir(), 'menus-bridge-task.xml');
    fs.writeFileSync(tmpXml, taskXml, 'utf16le');
    execSync(`schtasks /create /tn "MenusPrintBridge" /xml "${tmpXml}" /f`);
    fs.unlinkSync(tmpXml);
    console.log('✅ Auto-start task created (Task Scheduler). It will start on next login.');
}

function installMac() {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>kitchen.menus.print-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>${bridgePath}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${os.homedir()}/Library/Logs/menus-bridge.log</string>
  <key>StandardErrorPath</key><string>${os.homedir()}/Library/Logs/menus-bridge.log</string>
</dict>
</plist>`;
    const dest = path.join(os.homedir(), 'Library/LaunchAgents/kitchen.menus.print-bridge.plist');
    fs.writeFileSync(dest, plist);
    execSync(`launchctl load "${dest}"`);
    console.log('✅ LaunchAgent installed. Bridge will start on login and restart if it crashes.');
}

function installLinux() {
    const service = `[Unit]
Description=Menus Print Bridge
After=network.target

[Service]
ExecStart=/usr/bin/node ${bridgePath}
Restart=always
RestartSec=5
User=${os.userInfo().username}

[Install]
WantedBy=default.target
`;
    const systemdDir = path.join(os.homedir(), '.config/systemd/user');
    fs.mkdirSync(systemdDir, { recursive: true });
    fs.writeFileSync(path.join(systemdDir, 'menus-bridge.service'), service);
    execSync('systemctl --user daemon-reload');
    execSync('systemctl --user enable menus-bridge');
    execSync('systemctl --user start menus-bridge');
    console.log('✅ systemd user service installed and started. Logs: journalctl --user -u menus-bridge -f');
}

try {
    if (platform === 'win32')  installWindows();
    else if (platform === 'darwin') installMac();
    else installLinux();
} catch (e) {
    console.error('❌ Auto-start install failed:', e.message);
    console.error('You can still run the bridge manually with: node index.js');
    process.exit(1);
}
