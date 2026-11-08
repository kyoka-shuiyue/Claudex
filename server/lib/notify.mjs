// 发送完成后的系统通知（Windows 气泡通知；其他系统暂不支持时静默跳过）。
import { spawn } from 'node:child_process';

const PS = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = $env:CLAUDEX_TITLE
$n.BalloonTipText = $env:CLAUDEX_BODY
$n.Visible = $true
$n.ShowBalloonTip(8000)
Start-Sleep -Seconds 9
$n.Dispose()
`;

export function notifyText({ kind, dry, count, ok }) {
  if (kind === 'recovered') return { title: 'Claudex', body: `额度已恢复：${count} 个会话可以继续了（自动发送已关闭）` };
  if (dry) return { title: 'Claudex · 演练', body: `到点了：本应给 ${count} 个会话发送继续（演练模式，没有真的发送）` };
  if (ok === count) return { title: 'Claudex', body: `已开始处理 ${count} 个续接请求，投递与回复结果请查看软件` };
  return { title: 'Claudex', body: `处理 ${count} 个续接请求：${count - ok} 个暂未成功，详情请查看软件` };
}

export function notify(summary) {
  if (process.platform !== 'win32') return;
  const { title, body } = notifyText(summary);
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', PS], {
      env: { ...process.env, CLAUDEX_TITLE: title, CLAUDEX_BODY: body },
      detached: true, windowsHide: true, stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  } catch {}
}
