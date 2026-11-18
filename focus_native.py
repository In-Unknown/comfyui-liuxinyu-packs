"""Passive Windows events; never activate, focus, minimise or flash a window."""
import os
import threading


class NativeFocusMonitor:
    def __init__(self, emit):
        self.emit = emit
        self.status = "not_started"

    def start(self):
        if os.name != "nt":
            self.status = "unsupported_platform"
            return
        self.status = "starting"
        threading.Thread(target=self._run, name="liuxinyu-focus-observer", daemon=True).start()

    def _run(self):
        try:
            self._observe()
        except Exception as exc:
            self.status = "failed"
            self.emit("windows", {"kind": "observer-error", "error": str(exc)[:300]})

    def _observe(self):
        import ctypes as c
        from ctypes import wintypes as w
        u, k = c.WinDLL("user32", use_last_error=True), c.WinDLL("kernel32", use_last_error=True)
        result_type = c.c_ssize_t
        wndproc_type = c.WINFUNCTYPE(result_type, w.HWND, w.UINT, w.WPARAM, w.LPARAM)
        event_type = c.WINFUNCTYPE(None, w.HANDLE, w.DWORD, w.HWND, w.LONG, w.LONG, w.DWORD, w.DWORD)

        class WindowClass(c.Structure):
            _fields_ = [("style", w.UINT), ("proc", wndproc_type), ("clsExtra", c.c_int),
                        ("wndExtra", c.c_int), ("instance", w.HINSTANCE), ("icon", w.HICON),
                        ("cursor", w.HANDLE), ("background", w.HBRUSH), ("menu", w.LPCWSTR), ("name", w.LPCWSTR)]

        class GuiThreadInfo(c.Structure):
            _fields_ = [("size", w.DWORD), ("flags", w.DWORD), ("active", w.HWND),
                        ("focus", w.HWND), ("capture", w.HWND), ("menuOwner", w.HWND),
                        ("moveSize", w.HWND), ("caret", w.HWND), ("caretRect", w.RECT)]

        class LastInput(c.Structure):
            _fields_ = [("size", w.UINT), ("tick", w.DWORD)]

        def bind(lib, name, restype, args):
            fn = getattr(lib, name); fn.restype = restype; fn.argtypes = args
            return fn

        foreground = bind(u, "GetForegroundWindow", w.HWND, [])
        pid_of = bind(u, "GetWindowThreadProcessId", w.DWORD, [w.HWND, c.POINTER(w.DWORD)])
        iconic = bind(u, "IsIconic", w.BOOL, [w.HWND])
        style = bind(u, "GetWindowLongW", w.LONG, [w.HWND, c.c_int])
        open_process = bind(k, "OpenProcess", w.HANDLE, [w.DWORD, w.BOOL, w.DWORD])
        query_name = bind(k, "QueryFullProcessImageNameW", w.BOOL, [w.HANDLE,w.DWORD,w.LPWSTR,c.POINTER(w.DWORD)])
        close = bind(k, "CloseHandle", w.BOOL, [w.HANDLE])
        open_thread = bind(k, "OpenThread", w.HANDLE, [w.DWORD, w.BOOL, w.DWORD])
        thread_pid = bind(k, "GetProcessIdOfThread", w.DWORD, [w.HANDLE])
        gui_info = bind(u, "GetGUIThreadInfo", w.BOOL, [w.DWORD, c.POINTER(GuiThreadInfo)])
        last_input = bind(u, "GetLastInputInfo", w.BOOL, [c.POINTER(LastInput)])
        ticks = bind(k, "GetTickCount", w.DWORD, [])
        class_name = bind(u, "GetClassNameW", c.c_int, [w.HWND, w.LPWSTR, c.c_int])
        get_window = bind(u, "GetWindow", w.HWND, [w.HWND, w.UINT])
        module = bind(k, "GetModuleHandleW", w.HMODULE, [w.LPCWSTR])
        default = bind(u, "DefWindowProcW", result_type, [w.HWND,w.UINT,w.WPARAM,w.LPARAM])
        register = bind(u, "RegisterClassW", w.ATOM, [c.POINTER(WindowClass)])
        create = bind(u, "CreateWindowExW", w.HWND, [w.DWORD,w.LPCWSTR,w.LPCWSTR,w.DWORD,
                      c.c_int,c.c_int,c.c_int,c.c_int,w.HWND,w.HMENU,w.HINSTANCE,w.LPVOID])
        hook = bind(u, "SetWinEventHook", w.HANDLE, [w.DWORD,w.DWORD,w.HMODULE,event_type,w.DWORD,w.DWORD,w.DWORD])
        unhook = bind(u, "UnhookWinEvent", w.BOOL, [w.HANDLE])
        shell_register = bind(u, "RegisterShellHookWindow", w.BOOL, [w.HWND])
        shell_remove = bind(u, "DeregisterShellHookWindow", w.BOOL, [w.HWND])
        shell_message = bind(u, "RegisterWindowMessageW", w.UINT, [w.LPCWSTR])("SHELLHOOK")
        get_message = bind(u, "GetMessageW", w.BOOL, [c.POINTER(w.MSG),w.HWND,w.UINT,w.UINT])
        dispatch = bind(u, "DispatchMessageW", result_type, [c.POINTER(w.MSG)])
        destroy = bind(u, "DestroyWindow", w.BOOL, [w.HWND])
        unregister = bind(u, "UnregisterClassW", w.BOOL, [w.LPCWSTR,w.HINSTANCE])
        browsers = {"msedge.exe", "chrome.exe", "firefox.exe", "brave.exe", "vivaldi.exe", "opera.exe"}

        def process_name(pid):
            process = open_process(0x1000, False, pid)
            name = "unknown"
            if process:
                try:
                    buffer = c.create_unicode_buffer(1024); size = w.DWORD(1024)
                    if query_name(process, 0, buffer, c.byref(size)):
                        name = os.path.basename(buffer.value).lower()
                finally:
                    close(process)
            return name

        def describe(hwnd):
            pid = w.DWORD(); tid = pid_of(hwnd, c.byref(pid))
            cls = c.create_unicode_buffer(256); class_name(hwnd, cls, len(cls))
            gui = GuiThreadInfo(); gui.size = c.sizeof(gui)
            ok = bool(tid and gui_info(tid, c.byref(gui)))
            return {"hwnd": int(hwnd or 0), "pid": pid.value, "threadId": tid,
                    "process": process_name(pid.value), "class": cls.value,
                    "ownerHwnd": int(get_window(hwnd, 4) or 0),
                    "minimized": bool(iconic(hwnd)), "topmost": bool(style(hwnd, -20) & 8),
                    "gui": {key: int(getattr(gui, key) or 0) for key in
                            ("flags", "active", "focus", "capture", "menuOwner", "moveSize")} if ok else None}

        def emit(kind, hwnd, tick=None, event_thread=0):
            info = describe(hwnd)
            if info["process"] not in browsers and kind != "foreground":
                return
            source_pid = 0
            handle = open_thread(0x0800, False, event_thread) if event_thread else None
            error = c.get_last_error() if event_thread and not handle else 0
            if handle:
                try:
                    source_pid = thread_pid(handle)
                finally:
                    close(handle)
            current_tick = ticks()
            inp = LastInput(c.sizeof(LastInput), 0)
            input_age = ((current_tick - inp.tick) & 0xffffffff) if last_input(c.byref(inp)) else None
            self.emit("windows", {"kind": kind, "window": info, "foreground": describe(foreground()),
                                  "systemTickMs": tick, "observedTickMs": current_tick,
                                  "deliveryDelayMs": ((current_tick - tick) & 0xffffffff) if tick is not None else None,
                                  "lastInputAgeMs": input_age,
                                  "eventThread": {"id": event_thread, "pid": source_pid,
                                                  "process": process_name(source_pid) if source_pid else None,
                                                  "queryError": error}})

        @wndproc_type
        def proc(hwnd, msg, wp, lp):
            if msg == shell_message and wp == 0x8006:  # HSHELL_FLASH, not merely redraw
                try:
                    emit("shell-flash", lp)
                except Exception as exc:
                    self.emit("windows", {"kind": "callback-error", "callback": "shell", "error": repr(exc)})
            return default(hwnd,msg,wp,lp)

        @event_type
        def event(handle, code, hwnd, object_id, child_id, thread, tick):
            if not hwnd:
                return
            try:
                emit({3:"foreground", 0x16:"minimize-start", 0x17:"minimize-end"}[code], hwnd, tick, thread)
            except Exception as exc:
                self.emit("windows", {"kind": "callback-error", "callback": "winevent", "error": repr(exc)})

        instance = module(None)
        name = f"LiuxinyuFocusObserver_{os.getpid()}"
        cls = WindowClass(0,proc,0,0,instance,None,None,None,None,name)
        if not register(c.byref(cls)):
            raise c.WinError(c.get_last_error())
        hwnd = None; hooks = []
        try:
            # Hidden top-level window receives shell notifications; never shown.
            hwnd = create(0,name,"",0,0,0,0,0,None,None,instance,None)
            if not hwnd:
                raise c.WinError(c.get_last_error())
            shell = bool(shell_message and shell_register(hwnd))
            hooks = [hook(3,3,None,event,0,0,2), hook(0x16,0x17,None,event,0,0,2)]
            self.status = "active" if shell and all(hooks) else "partial"
            self.emit("windows", {"kind":"observer-started", "shellHook":shell,
                                  "foregroundHook":bool(hooks[0]), "minimizeHook":bool(hooks[1]),
                                  "foreground":describe(foreground())})
            msg = w.MSG()
            while get_message(c.byref(msg), None, 0, 0) > 0:
                u.TranslateMessage(c.byref(msg)); dispatch(c.byref(msg))
        finally:
            for item in hooks:
                if item: unhook(item)
            if hwnd:
                shell_remove(hwnd); destroy(hwnd)
            unregister(name,instance)
            self.status = "stopped"
