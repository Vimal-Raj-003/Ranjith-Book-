export type StyleId = "terminal" | "editorial" | "spotlight" | "blueprint";

export interface StylePreset {
  id: StyleId;
  name: string;
  blurb: string;
}

/** Offered in the create form, before a run starts. */
export const STYLES: StylePreset[] = [
  {
    id: "terminal",
    name: "Terminal Neon",
    blurb: "Dark, developer-native. Language-tinted accents on deep graphite.",
  },
  {
    id: "editorial",
    name: "Editorial",
    blurb: "Warm paper, serif headlines. Reads like a magazine feature.",
  },
  {
    id: "spotlight",
    name: "Spotlight",
    blurb: "Near-black with one hot accent. Punchy, high contrast, made for Shorts.",
  },
  {
    id: "blueprint",
    name: "Blueprint",
    blurb: "Deep indigo and drafting grid. Calm, technical, documentary.",
  },
];

/** Every style id, in the order the create form offers them. */
export const STYLE_IDS: StyleId[] = STYLES.map((s) => s.id);

export interface Theme {
  id: StyleId;
  name: string;
  bg: string;
  bgDeep: string;
  panelEdge: string;
  text: string;
  textDim: string;
  accent: string;
  accent2: string;
  codeInk: string;
  captionActive: string;
  captionIdle: string;
  fontDisplay: string;
  fontBody: string;
  fontMono: string;
  /** The repository window keeps GitHub's own palette in dark styles, and
   *  switches to GitHub's light palette on light backgrounds. */
  ghMode: "dark" | "light";
  gridOpacity: number;
}

const LANG_ACCENT: Record<string, [string, string]> = {
  TypeScript: ["#4dc4ff", "#8b7dff"],
  JavaScript: ["#ffd34d", "#ff8f4d"],
  Python: ["#4dd6a8", "#4dc4ff"],
  Rust: ["#ff8a5c", "#ffd34d"],
  Go: ["#5ad8f0", "#7de8c3"],
  Java: ["#ff9d5c", "#ff6b6b"],
  "C++": ["#7aa2ff", "#c58bff"],
  C: ["#8fa3c7", "#5ad8f0"],
  Ruby: ["#ff6b8b", "#ff9d5c"],
  PHP: ["#9d8bff", "#5ad8f0"],
  Swift: ["#ff8f5c", "#ffd34d"],
  Kotlin: ["#c58bff", "#ff8f5c"],
  Shell: ["#7de8c3", "#4dd6a8"],
  HTML: ["#ff8f5c", "#ffd34d"],
  CSS: ["#5ad8f0", "#8b7dff"],
  Vue: ["#6fe0a8", "#5ad8f0"],
  Dart: ["#5ad8f0", "#7de8c3"],
};

/** Mix a hex colour toward white. Used to keep small text above WCAG AA. */
function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function darken(hex: string, amount: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const mix = (c: number) => Math.round(c * (1 - amount));
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// Only fonts the renderer resolves automatically, so preview and render match.
const SANS = `Inter, sans-serif`;
const MONO = `"JetBrains Mono", monospace`;

export function themeFor(language: string, style: StyleId = "terminal"): Theme {
  const [langAccent, langAccent2] = LANG_ACCENT[language] ?? ["#5eead4", "#8b7dff"];

  switch (style) {
    case "editorial": {
      // Ink on paper: the accent is drawn from the language but darkened so it
      // holds contrast against a light ground.
      const accent = darken(langAccent, 0.55);
      const accent2 = darken(langAccent2, 0.45);
      return {
        id: style,
        name: "Editorial",
        bg: "#f7f4ee",
        bgDeep: "#ece7dd",
        panelEdge: "rgba(28,26,22,0.14)",
        text: "#1b1a17",
        textDim: "#6b6455",
        accent,
        accent2,
        codeInk: darken(langAccent2, 0.6),
        captionActive: accent,
        captionIdle: "#17160f",
        fontDisplay: SANS,
        fontBody: SANS,
        fontMono: MONO,
        ghMode: "light",
        gridOpacity: 0.05,
      };
    }

    case "spotlight": {
      // One hot accent on near-black. Deliberately louder than Terminal Neon.
      const accent = "#ff5c39";
      return {
        id: style,
        name: "Spotlight",
        bg: "#0a0708",
        bgDeep: "#040203",
        panelEdge: "rgba(255,255,255,0.10)",
        text: "#fdf6f3",
        textDim: "#a08f89",
        accent,
        accent2: "#ffb020",
        codeInk: "#ffc9b8",
        captionActive: accent,
        captionIdle: "#fff6f2",
        fontDisplay: SANS,
        fontBody: SANS,
        fontMono: MONO,
        ghMode: "dark",
        gridOpacity: 0.06,
      };
    }

    case "blueprint": {
      const accent = "#7fb2ff";
      return {
        id: style,
        name: "Blueprint",
        bg: "#0d1530",
        bgDeep: "#060b1c",
        panelEdge: "rgba(160,190,255,0.16)",
        text: "#e8eeff",
        textDim: "#8fa2cc",
        accent,
        accent2: "#9d8bff",
        codeInk: "#c7d8ff",
        captionActive: accent,
        captionIdle: "#f0f4ff",
        fontDisplay: SANS,
        fontBody: SANS,
        fontMono: MONO,
        ghMode: "dark",
        gridOpacity: 0.16,
      };
    }

    case "terminal":
    default:
      return {
        id: "terminal",
        name: "Terminal Neon",
        bg: "#0a0e17",
        bgDeep: "#05070d",
        panelEdge: "rgba(255,255,255,0.09)",
        text: "#f3f6fb",
        textDim: "#93a1b8",
        accent: langAccent,
        accent2: langAccent2,
        codeInk: lighten(langAccent2, 0.42),
        captionActive: langAccent,
        captionIdle: "#eef2f9",
        fontDisplay: SANS,
        fontBody: SANS,
        fontMono: MONO,
        ghMode: "dark",
        gridOpacity: 0.05,
      };
  }
}
