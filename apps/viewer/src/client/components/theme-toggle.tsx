import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { preferredTheme, saveTheme } from "../theme.ts";
import { Button } from "./ui/button.tsx";

export function ThemeToggle() {
  const [theme, setTheme] = useState(preferredTheme);
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return <Button id="theme-toggle" variant="outline" size="icon" aria-label={label} title={label} onClick={() => {
    const next = theme === "dark" ? "light" : "dark";
    saveTheme(next);
    setTheme(next);
  }}>{theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}</Button>;
}
