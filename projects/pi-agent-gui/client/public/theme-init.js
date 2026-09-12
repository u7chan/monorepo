// テーマの初回描画前適用 (CSP 対応のため外部 classic script)。
// localStorage の "pi-agent-theme" を読み、html の data-theme 属性を設定する。
// THEMES / FALLBACK / light の解決先は themeSync テストで themes.ts と突き合わせる。
(function () {
  var THEMES = ["midnight", "daylight", "mocha", "forest", "sakura", "sky"];
  var FALLBACK = "midnight";
  var choice;
  try {
    choice = localStorage.getItem("pi-agent-theme") || "system";
  } catch {
    choice = "system";
  }
  var id = choice;
  if (choice === "system" || THEMES.indexOf(choice) === -1) {
    var prefersLight = false;
    try {
      prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    } catch {
      prefersLight = false;
    }
    id = prefersLight ? "daylight" : FALLBACK;
  }
  document.documentElement.dataset.theme = id;
})();
