"""Windows toast bridge. Python owns dispatch; no browser permission is used."""

import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlsplit
import webbrowser


SCRIPT = r'''
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$appId = 'ComfyUI.Liuxinyu.TemplateForm'
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
if ($data.operation -eq 'remove') {
    [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($data.tag, 'forms', $appId)
    exit
}
$globalSetting = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' -Name ToastEnabled -ErrorAction SilentlyContinue
$appSetting = Get-ItemProperty -Path ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\' + $appId) -Name Enabled -ErrorAction SilentlyContinue
if ($globalSetting.ToastEnabled -eq 0 -or $appSetting.Enabled -eq 0) { throw 'Windows 已关闭通知，请在系统设置的通知页面允许 ComfyUI 通知。' }
$key = 'HKCU:\Software\Classes\AppUserModelId\' + $appId
$null = New-Item -Path $key -Force
$null = New-ItemProperty -Path $key -Name DisplayName -Value 'ComfyUI' -PropertyType String -Force
$protocol = 'HKCU:\Software\Classes\comfyui-liuxinyu-form'
$null = New-Item -Path ($protocol + '\shell\open\command') -Force
Set-Item -Path $protocol -Value 'URL:ComfyUI Form'
$null = New-ItemProperty -Path $protocol -Name 'URL Protocol' -Value '' -PropertyType String -Force
Set-Item -Path ($protocol + '\shell\open\command') -Value $data.command
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast activationType="protocol"><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$xml.DocumentElement.SetAttribute('launch', $data.url)
$texts = $xml.GetElementsByTagName('text')
$null = $texts.Item(0).AppendChild($xml.CreateTextNode('JSON Schema填写模版'))
$null = $texts.Item(1).AppendChild($xml.CreateTextNode($data.message))
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = $data.tag
$toast.Group = 'forms'
$toast.ExpirationTime = [DateTimeOffset]::Now.AddDays(1)
$notifier.Show($toast)
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
'''


def dispatch(request_id, message=None, url=None):
    if os.name != "nt":
        raise RuntimeError("原生系统通知目前仅支持 Windows；请在 ComfyUI 页面查看待填写表单。")
    executable = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    command = base64.b64encode(SCRIPT.encode("utf-16le")).decode("ascii")
    python = Path(sys.executable).with_name("pythonw.exe")
    if not python.exists():
        python = Path(sys.executable)
    command_line = f'"{python}" "{Path(__file__).resolve()}" --activate "%1"'
    payload = {"operation": "show" if message is not None else "remove", "tag": request_id[:16], "message": message, "url": url, "command": command_line}
    try:
        result = subprocess.run(
            [str(executable), "-NoProfile", "-NonInteractive", "-EncodedCommand", command],
            input=json.dumps(payload, ensure_ascii=False).encode("utf-8"), capture_output=True,
            timeout=20, creationflags=subprocess.CREATE_NO_WINDOW, check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Windows 通知服务在 20 秒内没有完成请求。") from error
    if result.returncode:
        detail = (result.stderr or result.stdout).decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Windows 系统通知发送失败：{detail[:1200] or result.returncode}")


def activation_target(uri):
    parts = urlsplit(uri)
    segments = parts.path.strip('/').split('/')
    if parts.scheme != 'comfyui-liuxinyu-form' or parts.netloc != 'activate' or len(segments) != 2:
        raise ValueError('无效的表单通知地址')
    port, token = segments
    if not port.isdigit() or not 1 <= int(port) <= 65535 or len(token) != 32 or any(c not in '0123456789abcdef' for c in token):
        raise ValueError('无效的表单通知标识')
    return f'http://127.0.0.1:{int(port)}', token


def focus_window(title):
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.ShowWindowAsync.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    found = []
    @callback_type
    def visit(hwnd, _):
        text = ctypes.create_unicode_buffer(1024)
        user32.GetWindowTextW(hwnd, text, len(text))
        if title in text.value:
            found.append(hwnd)
        return True
    for _ in range(10):
        user32.EnumWindows(visit, 0)
        if found:
            if user32.IsIconic(found[0]):
                user32.ShowWindowAsync(found[0], 9)
            return bool(user32.SetForegroundWindow(found[0]))
        time.sleep(.1)
    return False


def activate(uri):
    base, token = activation_target(uri)
    request = urllib.request.Request(f'{base}/liuxinyu/template_form/activate/{token}', data=b'{}', headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            result = json.load(response)
        if result.get('focused') or result.get('existing') and focus_window(result['title']):
            return
    except (OSError, ValueError):
        pass
    webbrowser.open(f'{base}/#lxy-form={token}', new=2)


if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--activate':
    activate(sys.argv[2])
