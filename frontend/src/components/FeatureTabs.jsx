import React from "react";

const TABS = [
  { id: "simplify", label: "Simplify Text" },
  { id: "planner", label: "Smart Schedule Planner" },
  { id: "gamified", label: "Gamified Learning" },
  { id: "breaktime", label: "Breaktime" },
  { id: "dashboard", label: "Dashboard" },
];

const MENTOR_TABS = [
  { id: "dashboard", label: "Student Dashboard" },
  { id: "assignments", label: "Assignments" },
  { id: "classes", label: "Classes" },
];

export default function FeatureTabs({ active, onChange, role = "guest" }) {
  const visibleTabs = role === "teacher"
    ? MENTOR_TABS
    : TABS;
  return (
    <nav className="feature-tabs" aria-label="Main features">
      {visibleTabs.map((t) => (
        <button
          key={t.id}
          className={`feature-tab ${active === t.id ? "feature-tab-active" : ""}`}
          type="button"
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

