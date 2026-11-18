"""Durable incident evidence, separate from ordinary rotating diagnostics."""
from collections import deque
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import unquote, urlsplit


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


class EvidenceStore:
    def __init__(self, directory, portable_root, tail_seconds=30):
        self.directory = Path(directory)
        self.root = self.directory/'focus-evidence'
        self.portable = Path(portable_root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.recent = deque(maxlen=2000)
        self.sessions = {}
        self.minimized = {}
        self.active = None
        self.tail_seconds = tail_seconds
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='focus-evidence')
        self.lock = threading.RLock()
        self.last_error = None
        self.last_incident = None
        self.known_files = {}

    def freeze_file(self, filename):
        """Compressed content-addressed copies: later replacements cannot alter them."""
        path = Path(filename)
        stat = path.stat()
        identity = (str(path.resolve()), stat.st_size, stat.st_mtime_ns)
        if identity in self.known_files:
            return self.known_files[identity]
        if shutil.disk_usage(self.root).free < max(128*1024*1024, stat.st_size*2):
            raise OSError('Insufficient free space for evidence; existing evidence retained')
        objects = self.root/'objects'
        objects.mkdir(exist_ok=True)
        temporary = objects/'copying.gz'
        digest = hashlib.sha256()
        append_only = path.name.startswith('focus') and '.jsonl' in path.name
        with path.open('rb') as source, gzip.open(temporary, 'wb', compresslevel=3) as output:
            remaining = stat.st_size
            while remaining:
                chunk = source.read(min(1024*1024, remaining))
                if not chunk:
                    raise OSError('Evidence source truncated during copy: ' + str(path))
                digest.update(chunk)
                output.write(chunk)
                remaining -= len(chunk)
        after = path.stat()
        if not append_only and (stat.st_size, stat.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            temporary.unlink(missing_ok=True)
            raise OSError('Evidence source changed during copy: ' + str(path))
        sha = digest.hexdigest()
        saved = objects/(sha+'.gz')
        if saved.exists():
            temporary.unlink()
        else:
            temporary.replace(saved)
        item = {'originalPath': str(path), 'sha256': sha, 'bytes': stat.st_size,
                'object': str(saved.relative_to(self.root)), 'savedAt': datetime.now(timezone.utc).isoformat()}
        self.known_files[identity] = item
        return item

    def _submit(self, function, *args):
        def run():
            try:
                function(*args)
            except Exception as exc:
                self.last_error = repr(exc)
                write_json(self.root/'last-error.json', {'time': datetime.now(timezone.utc).isoformat(),
                                                        'operation': function.__name__, 'error': repr(exc)})
        self.pool.submit(run)

    def observe(self, event):
        with self.lock:
            now = time.monotonic()
            record = {'receivedAt': datetime.now(timezone.utc).isoformat(), **event}
            self.recent.append(record)
            if event.get('kind') == 'ready':
                session = event.get('session', str(event['pid']))
                # Snapshot before the process exits, not when someone later reads the log.
                self.sessions[session] = record
                write_json(self.root/'sessions'/(re.sub(r'[^a-zA-Z0-9_-]', '_', session)+'.json'), record)
                self._submit(self._freeze_initial_modules, session, record)
            if self.active and now > self.active['until']:
                self.tick()
            reason = self._reason(event)
            created = False
            if reason and not self.active:
                folder = self.root/('incident-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
                folder.mkdir()
                manifest = {'reason': reason, 'event': record, 'sessions': list(self.sessions),
                            'preEvents': len(self.recent), 'tailSeconds': self.tail_seconds,
                            'finalized': False, 'retention': 'no automatic deletion'}
                write_json(folder/'manifest.json', manifest)
                stream = (folder/'native-calls.jsonl').open('w', encoding='utf-8')
                for item in self.recent:
                    stream.write(json.dumps(item, ensure_ascii=False)+'\n')
                stream.flush()
                os.fsync(stream.fileno())
                self.active = {'folder': folder, 'stream': stream, 'until': now+self.tail_seconds}
                self.last_incident = str(folder)
                # Events/manifest already durable before large file copies begin.
                self._submit(self._freeze_context, folder, dict(self.sessions), list(self.recent))
                created = True
            if self.active and not created:
                self.active['stream'].write(json.dumps(record, ensure_ascii=False)+'\n')
                self.active['stream'].flush()

    def _reason(self, event):
        if event.get('kind') != 'call':
            return None
        api, args = event.get('api', ''), event.get('args', {})
        hwnd = event.get('topWindow', event.get('hwnd'))
        command, tick = args.get('command'), event.get('time', 0)
        if 'ShowWindow' in api and command in (6, 7, 11):
            self.minimized[hwnd] = tick
        if 'FlashWindow' in api and args.get('flags', args.get('invert', 0)) and event.get('foreground') != hwnd:
            return 'background-flash-request'
        if event.get('minimizedBefore') and (('ShowWindow' in api and command not in (0, 6, 7, 11)) or
                                              command == 0xf120 or api == 'SetWindowPlacement'):
            return 'restore-request-while-minimized'
        if api in ('SetForegroundWindow', 'BringWindowToTop', 'SwitchToThisWindow') and hwnd in self.minimized:
            if 0 <= tick-self.minimized[hwnd] <= 2000:
                return 'activation-after-minimize'
        return None

    def _freeze_initial_modules(self, session, record):
        items, errors = [], []
        names = {'msedge.dll', 'msedge.exe', 'explorer.exe'}
        for module in record.get('modules', []):
            if module['name'].lower() not in names:
                continue
            try:
                items.append(self.freeze_file(module['path']))
            except OSError as exc:
                errors.append({'path': module['path'], 'error': str(exc)})
                self.last_error = str(exc)
        write_json(self.root/'sessions'/(re.sub(r'[^a-zA-Z0-9_-]', '_', session)+'-files.json'),
                   {'files': items, 'errors': errors})

    def _freeze_context(self, folder, sessions, records, phase='before'):
        files, errors, sources = [], [], set()
        # Copy the frame binaries actually involved, not every unrelated system DLL.
        for record in records:
            for frame in [record.get('caller', {}), *record.get('stack', [])]:
                if frame.get('path'):
                    sources.add(frame['path'])
                elif frame.get('module'):
                    for session in sessions.values():
                        if session.get('pid') == record.get('pid'):
                            sources.update(m['path'] for m in session.get('modules', []) if m['name']==frame['module'])
        for log in self.directory.glob('focus*.jsonl*'):
            if log.is_file():
                sources.add(str(log))
                if log.name.startswith('focus.jsonl'):
                    # Recorded local stack URLs identify exact bundles and their source maps.
                    text = log.read_text(encoding='utf-8', errors='replace')
                    for match in re.finditer(r'https?://(?:127\.0\.0\.1|localhost)(?::\d+)?/[^\s"\\)]+?\.js', text):
                        name = unquote(urlsplit(match.group()).path)
                        if name.startswith('/assets/'):
                            base = self.portable/'python_embeded/Lib/site-packages/comfyui_frontend_package/static/assets'
                            source = base/name[len('/assets/'):]
                        elif name.startswith('/extensions/'):
                            base = self.portable/'ComfyUI/custom_nodes'
                            source = base/name[len('/extensions/'):]
                        else:
                            continue
                        if source.resolve().is_relative_to(base.resolve()) and source.is_file():
                            sources.add(str(source))
                            if Path(str(source)+'.map').is_file():
                                sources.add(str(source)+'.map')
        # Record installed sources now; no browser/renderer memory is dumped.
        for filename in sorted(sources):
            try:
                files.append(self.freeze_file(filename))
            except OSError as exc:
                errors.append({'path': filename, 'error': str(exc)})
                self.last_error = str(exc)
        write_json(folder/('files.json' if phase == 'before' else 'files-after.json'), {'files': files, 'errors': errors,
                                        'note': 'File bytes saved at capture time; loaded JS bytes are not independently hashed by the page.'})

    def tick(self):
        with self.lock:
            if self.active and time.monotonic() > self.active['until']:
                self.active['stream'].flush()
                os.fsync(self.active['stream'].fileno())
                self.active['stream'].close()
                manifest_path = self.active['folder']/'manifest.json'
                manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
                manifest.update(finalized=True, endedAt=datetime.now(timezone.utc).isoformat())
                write_json(manifest_path, manifest)
                self._submit(self._freeze_context, self.active['folder'], dict(self.sessions), list(self.recent), 'after')
                self.active = None

    def close(self):
        with self.lock:
            if self.active:
                self.active['until'] = 0
                self.tick()
        self.pool.shutdown(wait=True)
