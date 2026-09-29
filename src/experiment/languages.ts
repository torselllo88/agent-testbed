/**
 * Part of the agent protocol. Human-readable names for common language codes, used only to phrase the
 * instruction to agents ("write in Russian (ru)"). Any other code is passed
 * through as-is — the conversation itself supports whatever the model does.
 */
const NAMES: Record<string, string> = {
  en: "English",
  ru: "Russian",
  sr: "Serbian",
  "sr-latn": "Serbian (Latin script)",
  "sr-cyrl": "Serbian (Cyrillic script)",
  uk: "Ukrainian",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  "pt-br": "Brazilian Portuguese",
  pl: "Polish",
  cs: "Czech",
  nl: "Dutch",
  tr: "Turkish",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
};

export function languageName(code: string): string {
  const lower = code.toLowerCase();
  return NAMES[lower] ?? NAMES[lower.split("-")[0]!] ?? code;
}

/** Suggestions for UI pickers; any code can still be entered. */
export const COMMON_LANGUAGES = ["en", "ru", "sr-Latn", "uk", "de", "fr", "es"] as const;
