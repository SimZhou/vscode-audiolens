import { messages as de } from "./locales/de";
import { messages as en } from "./locales/en";
import { messages as es } from "./locales/es";
import { messages as fr } from "./locales/fr";
import { messages as id } from "./locales/id";
import { messages as it } from "./locales/it";
import { messages as ja } from "./locales/ja";
import { messages as ko } from "./locales/ko";
import { messages as nl } from "./locales/nl";
import { messages as no } from "./locales/no";
import { messages as pl } from "./locales/pl";
import { messages as pt } from "./locales/pt";
import { messages as ru } from "./locales/ru";
import { messages as tr } from "./locales/tr";
import { messages as vi } from "./locales/vi";
import { messages as zhCN } from "./locales/zh-CN";
import { messages as zhTW } from "./locales/zh-TW";
import { LocaleCode, LocaleMessages, LocaleSetting } from "./types";

export const SUPPORTED_LOCALES: LocaleCode[] = [
  "zh-CN",
  "zh-TW",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "ru",
  "es",
  "it",
  "pt",
  "id",
  "no",
  "nl",
  "pl",
  "tr",
  "vi"
];

const localeMessages: Partial<Record<LocaleCode, Partial<LocaleMessages>>> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  ja,
  ko,
  fr,
  de,
  ru,
  es,
  it,
  pt,
  id,
  no,
  nl,
  pl,
  tr,
  vi
};

export function getMessages(locale: LocaleCode): LocaleMessages {
  return { ...en, ...(localeMessages[locale] ?? {}) } as LocaleMessages;
}

export function normalizeLocale(language: string | undefined): LocaleCode {
  const value = (language || "en").toLowerCase();
  if (value === "zh-tw" || value === "zh-hk" || value === "zh-hant" || value.startsWith("zh-hant")) {
    return "zh-TW";
  }
  if (value === "zh-cn" || value === "zh-sg" || value === "zh-hans" || value.startsWith("zh")) {
    return "zh-CN";
  }
  if (value.startsWith("ja")) return "ja";
  if (value.startsWith("ko")) return "ko";
  if (value.startsWith("fr")) return "fr";
  if (value.startsWith("de")) return "de";
  if (value.startsWith("ru")) return "ru";
  if (value.startsWith("es")) return "es";
  if (value.startsWith("it")) return "it";
  if (value.startsWith("pt")) return "pt";
  if (value.startsWith("id")) return "id";
  if (value.startsWith("no") || value.startsWith("nb") || value.startsWith("nn")) return "no";
  if (value.startsWith("nl")) return "nl";
  if (value.startsWith("pl")) return "pl";
  if (value.startsWith("tr")) return "tr";
  if (value.startsWith("vi")) return "vi";
  return "en";
}

export function resolveLocale(setting: LocaleSetting | undefined, vscodeLanguage: string | undefined): LocaleCode {
  if (setting && setting !== "auto") {
    return setting;
  }
  return normalizeLocale(vscodeLanguage);
}
