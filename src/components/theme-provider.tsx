import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type Theme = "dark" | "light" | "system";

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: Theme) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState>({
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => undefined,
});

const STORAGE_KEY = "msm-ui-theme";

function systemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
}: {
  children: ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "dark" || stored === "light" || stored === "system"
      ? stored
      : defaultTheme;
  });
  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">(() =>
    theme === "system" ? systemTheme() : theme,
  );

  useEffect(() => {
    const root = document.documentElement;
    const apply = (value: "dark" | "light") => {
      root.classList.remove("dark", "light");
      root.classList.add(value);
      setResolvedTheme(value);
    };
    if (theme === "system") {
      apply(systemTheme());
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => apply(systemTheme());
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }
    apply(theme);
  }, [theme]);

  return (
    <ThemeProviderContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeProviderContext);
}
