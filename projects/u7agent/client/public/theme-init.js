// 初回描画の点滅を避けるため React より先に実行する。CSP に合わせ外部 classic script に置く。
(function () {
  var THEMES = ["midnight", "daylight", "mocha", "forest", "sakura", "sky"];
  var FALLBACK = "midnight";
  var choice;
  try {
    choice = localStorage.getItem("u7agent-theme") || "system";
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
