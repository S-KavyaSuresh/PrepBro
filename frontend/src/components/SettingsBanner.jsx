import React, { useEffect, useMemo, useState } from "react";

const FONT_MAP = {
  lexend:     '"Lexend", sans-serif',
  atkinson:   '"Atkinson Hyperlegible", sans-serif',
  opendyslexic:'"OpenDyslexic", sans-serif',
  comic:      '"Comic Sans MS", "Comic Sans", cursive',
  andika:     '"Andika", sans-serif',
  nunito:     '"Nunito", sans-serif',
  trebuchet:  '"Trebuchet MS", sans-serif',
};

export default function SettingsBanner() {
  const [open,          setOpen]          = useState(false);
  const [fontFamily,    setFontFamily]    = useState("lexend");
  const [fontSize,      setFontSize]      = useState(18);
  const [lineHeight,    setLineHeight]    = useState(1.6);
  const [wordSpacing,   setWordSpacing]   = useState(0.1);
  const [letterSpacing, setLetterSpacing] = useState(0.04);
  const [theme,         setTheme]         = useState("calm");

  const family = useMemo(() => FONT_MAP[fontFamily] || FONT_MAP.lexend, [fontFamily]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-family-base",    family);
    root.style.setProperty("--font-size-base",      `${fontSize}px`);
    root.style.setProperty("--line-height-base",    `${lineHeight}`);
    root.style.setProperty("--word-spacing-base",   `${wordSpacing}em`);
    root.style.setProperty("--letter-spacing-base", `${letterSpacing}em`);
    document.body.style.fontSize      = `${fontSize}px`;
    document.body.style.fontFamily    = family;
    document.body.style.lineHeight    = `${lineHeight}`;
    document.body.style.wordSpacing   = `${wordSpacing}em`;
    document.body.style.letterSpacing = `${letterSpacing}em`;
  }, [family, fontSize, lineHeight, wordSpacing, letterSpacing]);

  useEffect(() => {
    document.body.classList.remove("theme-warm","theme-dark","theme-high-contrast","theme-calm");
    document.body.classList.add(
      theme === "warm"          ? "theme-warm" :
      theme === "dark"          ? "theme-dark" :
      theme === "high-contrast" ? "theme-high-contrast" : "theme-calm"
    );
  }, [theme]);

  return (
    <aside
      className={`settings-banner ${open ? "settings-banner-open" : "settings-banner-closed"}`}
      aria-label="Comfort settings"
    >
      <button
        className="settings-toggle-handle"
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label="Toggle settings"
      >
        <span>{open ? "›" : "‹"}</span>
      </button>

      <div className="settings-content">
        <h2 className="settings-title">⚙️ Comfort Settings</h2>

        <div className="settings-group">
          <label className="settings-label">Font Style</label>
          <select className="settings-select" value={fontFamily} onChange={e => setFontFamily(e.target.value)}>
            <option value="lexend">Lexend ★ Highly Readable</option>
            <option value="atkinson">Atkinson Hyperlegible</option>
            <option value="opendyslexic">OpenDyslexic</option>
            <option value="comic">Comic Sans</option>
            <option value="andika">Andika</option>
            <option value="nunito">Nunito (Rounded)</option>
            <option value="trebuchet">Trebuchet MS</option>
          </select>
        </div>

        <div className="settings-group">
          <label className="settings-label">
            Font Size <span className="settings-value">{fontSize}px</span>
          </label>
          <input type="range" min="14" max="30" value={fontSize} className="settings-range"
            onChange={e => setFontSize(Number(e.target.value))} />
        </div>

        <div className="settings-group">
          <label className="settings-label">
            Line Spacing <span className="settings-value">{lineHeight}×</span>
          </label>
          <input type="range" min="1.2" max="2.5" step="0.1" value={lineHeight} className="settings-range"
            onChange={e => setLineHeight(Number(e.target.value))} />
        </div>

        <div className="settings-group">
          <label className="settings-label">
            Word Spacing <span className="settings-value">{wordSpacing}em</span>
          </label>
          <input type="range" min="0" max="0.8" step="0.05" value={wordSpacing} className="settings-range"
            onChange={e => setWordSpacing(Number(e.target.value))} />
        </div>

        <div className="settings-group">
          <label className="settings-label">
            Letter Spacing <span className="settings-value">{letterSpacing}em</span>
          </label>
          <input type="range" min="0" max="0.4" step="0.02" value={letterSpacing} className="settings-range"
            onChange={e => setLetterSpacing(Number(e.target.value))} />
        </div>

        <div className="settings-group">
          <label className="settings-label">Theme</label>
          <select className="settings-select" value={theme} onChange={e => setTheme(e.target.value)}>
            <option value="calm">🌊 Calm Blue</option>
            <option value="warm">🌅 Warm Sand</option>
            <option value="dark">🌙 Night Mode</option>
            <option value="high-contrast">⬛ High Contrast</option>
          </select>
        </div>

        <div className="settings-group">
          <label className="settings-label">🎵 Soothing Sounds</label>
          <div className="sound-removed-notice">
            🎧 Play calm music on YouTube or Spotify while you study for best focus! 🌿
          </div>
        </div>
      </div>
    </aside>
  );
}
