import { useEffect, useState } from 'react';

/**
 * Today on the viewer's own clock, `YYYY-MM-DD`. Commands that take a day default to the server's
 * (UTC) one, which for somebody east of Greenwich is still yesterday for the first hours after
 * midnight.
 */
export const localDay = (now = new Date()): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/**
 * Today on the viewer's own clock (`localDay`), which turns over at local midnight: a page left
 * open — a dashboard on a wall — asks about the new day without being loaded again.
 */
export function useLocalDay(): string {
  const [day, setDay] = useState(localDay);
  useEffect(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    // A second past, so the clock has turned whatever the timer's drift.
    const timer = setTimeout(() => setDay(localDay()), midnight.getTime() - now.getTime() + 1000);
    return () => clearTimeout(timer);
  }, [day]);
  return day;
}
