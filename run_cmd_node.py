"""运行 cmd 命令节点。"""

import os
import subprocess
import tempfile
import threading
import uuid


class RunCmd:
    DISPLAY_NAME = "运行cmd命令"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "command": ("STRING", {"default": "echo Hello", "multiline": True}),
                "timeout": ("INT", {"default": 10, "min": 0, "max": 3600, "tooltip": "最长等待时间(秒)，0为无限等待"}),
                "kill_on_timeout": ("BOOLEAN", {"default": True, "tooltip": "超时时是否强制结束程序和终端"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("输出",)
    FUNCTION = "execute"
    CATEGORY = "utils/command"

    def execute(self, command, timeout, kill_on_timeout):
        if not command.strip():
            return ("",)

        bat_path = os.path.join(
            tempfile.gettempdir(), f"liuxinyu_cmd_{uuid.uuid4().hex}.bat"
        )
        with open(bat_path, "w", encoding="utf-8", errors="replace", newline="") as f:
            f.write("@echo off\r\n")
            f.write("chcp 65001 >nul\r\n")
            for line in command.splitlines():
                f.write(line + "\r\n")

        try:
            process = subprocess.Popen(
                ["cmd.exe", "/c", bat_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NEW_CONSOLE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )

            if timeout == 0:
                stdout, _ = process.communicate()
                return (stdout or "",)

            try:
                stdout, _ = process.communicate(timeout=timeout)
                return (stdout or "",)
            except subprocess.TimeoutExpired as e:
                out = e.stdout or ""
                if isinstance(out, bytes):
                    out = out.decode("utf-8", errors="replace")

                if kill_on_timeout:
                    try:
                        subprocess.run(
                            ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                            capture_output=True,
                        )
                    except Exception:
                        process.kill()

                    try:
                        rem_out, _ = process.communicate(timeout=2)
                        if rem_out:
                            out += rem_out
                    except Exception:
                        pass
                else:
                    def drain_output(p):
                        try:
                            p.communicate()
                        except Exception:
                            pass

                    t = threading.Thread(target=drain_output, args=(process,))
                    t.daemon = True
                    t.start()

                return (out,)
        finally:
            if os.path.exists(bat_path):
                try:
                    os.remove(bat_path)
                except Exception:
                    pass
