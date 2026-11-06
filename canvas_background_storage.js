const DIRECTORY = "liuxinyu/canvas-background";
const CONFIG = `${DIRECTORY}/background.json`;

// ComfyUI's user-data endpoint scopes files to the active user and writes atomically.
export function createBackgroundStore(api, legacy) {
  const uploaded = new WeakMap();
  const pendingFiles = new WeakMap();
  const request = (path, options = {}) => api.fetchApi(`/userdata/${encodeURIComponent(path)}`, { cache: "no-store", ...options });
  const check = (response, action) => {
    if (!response.ok) throw new Error(`${action}失败 (${response.status})`);
    return response;
  };
  const write = async (path, options, action) => {
    const controller = new AbortController(), started = Date.now();
    let response, detail = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    try {
      response = await request(path, { ...options, signal: controller.signal });
      if (!response.ok) {
        detail = await response.text();
        throw new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim());
      }
    } catch (error) {
      throw new Error([
        `${action}失败`, `请求：POST /userdata/${encodeURIComponent(path)}`, `文件：${path}`,
        `耗时：${Date.now() - started} ms；超时限制：15000 ms`,
        `HTTP：${response ? `${response.status} ${response.statusText || ""}`.trim() : "未收到响应"}`,
        `请求标识：${response?.headers?.get("x-request-id") || "未提供"}`,
        `响应正文：${detail || "（空或未能读取）"}`, timedOut ? "请求已超时并取消" : "",
        `异常：${error.stack || error.message || String(error)}`,
      ].filter(Boolean).join("\n"), { cause: error });
    } finally { clearTimeout(timer); }
  };
  const save = async value => {
    const records = [];
    for (const record of value.records) {
      let file = uploaded.get(record.blob);
      if (!file) {
        file = pendingFiles.get(record.blob);
        if (!file) {
          const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
          const extension = record.blob.type === "image/png" ? "png" :
            record.blob.type === "image/gif" || record.animated ? "gif" : "webp";
          file = `images/${id}.${extension}`;
          pendingFiles.set(record.blob, file);
        }
        await write(`${DIRECTORY}/${file}`, { method: "POST", body: record.blob }, `图片“${record.name}”保存`);
        uploaded.set(record.blob, file);
        pendingFiles.delete(record.blob);
      }
      records.push({ name: record.name, ratio: record.ratio, file, animated: Boolean(record.animated) });
    }
    // Commit the manifest only after every referenced image exists on disk.
    await write(CONFIG, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, settings: value.settings, records }) }, "背景配置保存");
  };
  const load = async () => {
    const response = await request(CONFIG);
    if (response.status === 404) {
      const previous = await legacy();
      return previous ? { ...previous, needsMigration: true } : null;
    }
    check(response, "背景配置读取");
    const value = await response.json();
    if (value.version !== 1 || !Array.isArray(value.records) || !value.settings || typeof value.settings !== "object") throw new Error("背景配置格式无效");
    const records = [];
    for (const record of value.records) {
      if (!/^images\/[a-f0-9]{32}\.(webp|png|gif)$/.test(record.file) || !(record.ratio > 0) || !Number.isFinite(record.ratio)) throw new Error("背景图片记录无效");
      const image = check(await request(`${DIRECTORY}/${record.file}`), `图片“${record.name}”读取`);
      const blob = await image.blob(); uploaded.set(blob, record.file);
      records.push({ name: String(record.name), ratio: record.ratio, blob, animated: /\.gif$/i.test(record.file) });
    }
    return { settings: value.settings, records };
  };
  return { save, load, directory: DIRECTORY };
}
