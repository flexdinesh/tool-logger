import { usePreferences } from "../preferences.tsx";
export function ThemeToggle() {
  const { preferences, updatePreferences } = usePreferences();
  return <label className="theme-control"><span className="sr-only">Theme</span><select aria-label="Theme" value={preferences.theme}
    onChange={(e) => { const theme = e.currentTarget.value; if (theme === "light" || theme === "dark" || theme === "system") updatePreferences({ theme }); }}>
    <option value="system">System theme</option><option value="light">Light theme</option><option value="dark">Dark theme</option>
  </select></label>;
}
