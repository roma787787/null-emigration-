import { test } from "node:test";
import assert from "node:assert/strict";
import { translations, languages } from "./translations.js";
import { t, DEFAULT_LANGUAGE } from "./index.js";

test("every translation key exists in all three languages", () => {
  const referenceKeys: string[] = Object.keys(translations.en);

  for (const lang of languages) {
    const keys = new Set(Object.keys(translations[lang]));
    const missing: string[] = referenceKeys.filter((k) => !keys.has(k));
    const extra: string[] = [...keys].filter((k) => !referenceKeys.includes(k));
    assert.deepEqual(missing, [], `${lang} is missing keys: ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `${lang} has extra keys not in en: ${extra.join(", ")}`);
  }
});

test("t() interpolates {var} placeholders", () => {
  const result = t("en", "addToken.lookingUp", { address: "0xABC", network: "ethereum" });
  assert.equal(result, "Looking up 0xABC on ethereum...");
});

test("t() falls back to the default language for a null lang", () => {
  const result = t(null, "settings.title");
  assert.equal(result, t(DEFAULT_LANGUAGE, "settings.title"));
});

test("t() returns distinct text per language for the same key", () => {
  const en = t("en", "card.network");
  const uk = t("uk", "card.network");
  const ru = t("ru", "card.network");
  assert.notEqual(en, uk);
  assert.notEqual(en, ru);
  assert.notEqual(uk, ru);
});
