import type { Language } from "../../types/index.js";
import { translations, languages, languageLabels } from "./translations.js";

export { languages, languageLabels };
export const DEFAULT_LANGUAGE: Language = "en";

export function t(lang: Language | null, key: string, vars?: Record<string, string | number>): string {
  const dict = translations[lang ?? DEFAULT_LANGUAGE];
  let template = dict[key] ?? translations[DEFAULT_LANGUAGE][key] ?? key;

  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      template = template.replaceAll(`{${name}}`, String(value));
    }
  }

  return template;
}
