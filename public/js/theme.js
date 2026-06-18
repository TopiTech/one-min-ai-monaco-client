/**
 * Theme management module
 * Handles dark/light mode switching with localStorage persistence
 */

const STORAGE_KEY_THEME = "monaco_client_theme";

let _themeToggleTimer = null;

export function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY_THEME);
  if (saved) {
    document.documentElement.setAttribute("data-theme", saved);
  }
  updateThemeUI();
}

export function toggleTheme() {
  if (_themeToggleTimer) return;
  _themeToggleTimer = setTimeout(() => {
    _themeToggleTimer = null;
  }, 200);

  const current = document.documentElement.getAttribute("data-theme");
  let next;
  if (current === "light") {
    next = "dark";
  } else if (current === "dark") {
    next = "light";
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    next = prefersDark ? "light" : "dark";
  }

  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(STORAGE_KEY_THEME, next);
  updateThemeUI();

  return next;
}

export function updateThemeUI() {
  const theme = document.documentElement.getAttribute("data-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = theme === "dark" || (!theme && prefersDark);

  const iconDark = document.getElementById("themeIconDark");
  const iconLight = document.getElementById("themeIconLight");
  const label = document.getElementById("themeLabel");

  if (iconDark) iconDark.classList.toggle("is-hidden", isDark);
  if (iconLight) iconLight.classList.toggle("is-hidden", !isDark);
  if (label) label.textContent = isDark ? "ライトモード" : "ダークモード";

  return isDark;
}

export function getSavedTheme() {
  return localStorage.getItem(STORAGE_KEY_THEME);
}

export function isDarkTheme() {
  const saved = getSavedTheme();
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return saved === "dark" || (!saved && prefersDark);
}
