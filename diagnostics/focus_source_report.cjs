// Resolve recorded browser stacks against the installed frontend's source maps.
const fs = require('node:fs');
const path = require('node:path');
const { SourceMap } = require('node:module');
const maps = new Map();

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function resolveFrame(frame, portableRoot) {
  const match = frame.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/);
  if (!match) return { frame, status: 'no-source-location' };
  const url = new URL(match[1]);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    return { frame, status: 'non-local-source' };
  const roots = {
    '/assets/': path.join(portableRoot, 'python_embeded/Lib/site-packages/comfyui_frontend_package/static/assets'),
    '/extensions/': path.join(portableRoot, 'ComfyUI/custom_nodes'),
  };
  const prefix = Object.keys(roots).find(key => url.pathname.startsWith(key));
  if (!prefix) return { frame, status: 'unmapped-url' };
  const root = path.resolve(roots[prefix]);
  const file = path.resolve(root, decodeURIComponent(url.pathname.slice(prefix.length)));
  if (!inside(root, file) || !file.endsWith('.js') || !fs.existsSync(file))
    return { frame, status: 'source-unavailable' };
  const line = Number(match[2]), column = Number(match[3]);
  let source = file, sourceLine = line, sourceColumn = column, content, mapped = false;
  const mapFile = file + '.map';
  if (fs.existsSync(mapFile)) {
    if (!maps.has(mapFile)) {
      const payload = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      maps.set(mapFile, { payload, map: new SourceMap(payload) });
    }
    const { payload, map } = maps.get(mapFile);
    const entry = map.findEntry(line - 1, column - 1);
    if (entry.originalSource !== undefined) {
      const index = payload.sources.indexOf(entry.originalSource);
      source = entry.originalSource;
      sourceLine = entry.originalLine + 1;
      sourceColumn = entry.originalColumn + 1;
      content = payload.sourcesContent?.[index];
      mapped = true;
    }
  }
  if (!mapped) content = fs.readFileSync(file, 'utf8');
  const lines = content?.split(/\r?\n/) ?? [];
  return { frame, status: mapped ? 'source-map' : 'direct', generatedFile: file,
    generatedLine: line, generatedColumn: column, source, line: sourceLine, column: sourceColumn,
    context: lines.slice(Math.max(0, sourceLine - 3), sourceLine + 2)
      .map((text, index) => ({ line: Math.max(1, sourceLine - 2) + index, text })) };
}

function resolveStack(stack, portableRoot) {
  return String(stack || '').split('\n').filter(Boolean).map(frame => resolveFrame(frame, portableRoot));
}

module.exports = { resolveFrame, resolveStack };
if (require.main === module) {
  const [input, output, root = path.resolve(__dirname, '../../../..')] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node focus_source_report.cjs INPUT.jsonl OUTPUT.json [PORTABLE_ROOT]');
  const records = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const result = records.filter(record => record.stack && record.suspicious).map(record => ({
    time: record.time, session: record.session, kind: record.kind,
    frames: resolveStack(record.stack, root),
  }));
  fs.writeFileSync(output, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ suspiciousCalls: result.length, resolvedFrames:
    result.reduce((count, record) => count + record.frames.filter(f => ['source-map', 'direct'].includes(f.status)).length, 0) }));
}
