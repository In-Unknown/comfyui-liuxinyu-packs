import { app } from '../../scripts/app.js';
import { api } from '../../scripts/api.js';
import { version } from '/liuxinyu/frontend/version.js';

app.registerExtension({
  name: 'liuxinyu.FrontendVersion',
  setup() {
    let reporting = false, reloading = false;
    const storageKey = 'liuxinyu.frontend.reload';
    const reload = async (target) => {
      if (!target || target === version || reloading) return;
      let previous;
      try { previous = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch {}
      // At most one automatic attempt for a given release in this browser tab.
      if (previous?.version === target) {
        if (!reloading) app.extensionManager?.toast?.add({severity:'warn',summary:'页面版本更新未完成',detail:'自动刷新后仍是旧版本，请保存工作并强制刷新页面。',life:10000});
        reloading = true;
        return;
      }
      reloading = true;
      try {
        await app.ui.settings.setSettingValueAsync('Comfy.Window.UnloadConfirmation', false);
      } catch (error) {
        reloading = false;
        console.error('[liuxinyu] Failed to disable reload confirmation', error);
        return;
      }
      try { sessionStorage.setItem(storageKey, JSON.stringify({version:target})); } catch {}
      window.location.reload();
    };
    try {
      const previous = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (previous?.version === version) sessionStorage.removeItem(storageKey);
    } catch {}
    const report = async () => {
      if (reporting || reloading || !api.clientId) return;
      reporting = true;
      try {
        const response = await api.fetchApi('/liuxinyu/frontend/version', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({client_id:api.clientId, version}),
        });
        if (response.ok) { const data = await response.json(); if (data.reload) reload(data.version); }
      } catch (error) { console.debug('[liuxinyu] 版本握手等待连接恢复', error); }
      finally { reporting = false; }
    };
    api.addEventListener('liuxinyu.frontend_version_query', report);
    api.addEventListener('liuxinyu.frontend_reload', ({detail}) => reload(detail.version));
    api.addEventListener('reconnected', report);
    void report();
  },
});
