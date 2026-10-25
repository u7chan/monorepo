// 初回描画の点滅を避けるため React より先に実行する。CSP に合わせ外部 classic script に置く。
(function () {
  var THEMES = [
    "midnight",
    "mocha",
    "forest",
    "catppuccin-mocha",
    "catppuccin-frappe",
    "nord",
    "tokyo-night",
    "kanagawa",
    "gruvbox-dark",
    "everforest-dark",
    "dracula",
    "daylight",
    "sakura",
    "sky",
    "catppuccin-latte",
    "gruvbox-light",
    "rose-pine-dawn",
    "everforest-light",
    "one-light",
    "solarized-light",
  ];
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
