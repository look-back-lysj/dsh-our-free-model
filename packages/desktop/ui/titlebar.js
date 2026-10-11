// OFM 桌面版·标题栏注入脚本
// 在 webview 加载完成后注入自定义标题栏

(function() {
  // 避免重复注入
  if (document.getElementById('ofm-titlebar')) return;

  // 创建标题栏
  const titlebar = document.createElement('div');
  titlebar.id = 'ofm-titlebar';
  titlebar.innerHTML = `
    <div class="ofm-tb-title">OUR FREE MODEL</div>
    <div class="ofm-tb-actions">
      <button class="ofm-tb-btn minimize" title="最小化" onclick="ofmMinimize()">
        <svg viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1" fill="currentColor"/></svg>
      </button>
      <button class="ofm-tb-btn maximize" title="最大化" onclick="ofmMaximize()">
        <svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/></svg>
      </button>
      <button class="ofm-tb-btn close" title="关闭" onclick="ofmClose()">
        <svg viewBox="0 0 12 12"><path d="M3,3 L9,9 M9,3 L3,9" stroke="currentColor" stroke-width="1"/></svg>
      </button>
    </div>
  `;

  // 注入到 body 最前面
  document.body.insertBefore(titlebar, document.body.firstChild);

  // 窗口控制函数（通过 Tauri API 调用）
  window.ofmMinimize = function() {
    if (window.__TAURI__) {
      window.__TAURI__.window.getCurrent().minimize();
    }
  };

  window.ofmMaximize = function() {
    if (window.__TAURI__) {
      const win = window.__TAURI__.window.getCurrent();
      win.isMaximized().then(maximized => {
        if (maximized) {
          win.unmaximize();
        } else {
          win.maximize();
        }
      });
    }
  };

  window.ofmClose = function() {
    if (window.__TAURI__) {
      window.__TAURI__.window.getCurrent().hide();
    }
  };
})();