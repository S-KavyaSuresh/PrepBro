/**
 * Smart Schedule Planner Utility
 * Generates a balanced study schedule based on user inputs.
 */

export function generateSchedule({ subjects, totalHoursPerDay, days, focusPriority }) {
  // Simple heuristic for balancing:
  // Allocate time based on priority (if any) or evenly.
  const schedule = [];
  const hoursPerSubject = totalHoursPerDay / subjects.length;

  days.forEach((day) => {
    const dayPlan = {
      day,
      sessions: subjects.map((subj, idx) => ({
        subject: subj,
        duration: hoursPerSubject,
        startTime: `${9 + idx * (hoursPerSubject + 0.5)}:00`, // Starts at 9 AM with breaks
        break: "15 min",
      })),
    };
    schedule.push(dayPlan);
  });

  return schedule;
}

export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
