import test from "node:test";
import assert from "node:assert/strict";

import { messages as de } from "./i18n/locales/de";
import { messages as en } from "./i18n/locales/en";
import { messages as es } from "./i18n/locales/es";
import { messages as fr } from "./i18n/locales/fr";
import { messages as id } from "./i18n/locales/id";
import { messages as it } from "./i18n/locales/it";
import { messages as ja } from "./i18n/locales/ja";
import { messages as ko } from "./i18n/locales/ko";
import { messages as nl } from "./i18n/locales/nl";
import { messages as no } from "./i18n/locales/no";
import { messages as pl } from "./i18n/locales/pl";
import { messages as pt } from "./i18n/locales/pt";
import { messages as ru } from "./i18n/locales/ru";
import { messages as tr } from "./i18n/locales/tr";
import { messages as vi } from "./i18n/locales/vi";
import { messages as zhCN } from "./i18n/locales/zh-CN";
import { messages as zhTW } from "./i18n/locales/zh-TW";
import { LocaleCode, LocaleMessages } from "./i18n/types";

const playbackMessageKeys = [
  "playbackMode",
  "playbackModeTitle",
  "playbackDownmix",
  "playbackBypass",
  "playbackBypassFallback"
] satisfies Array<keyof LocaleMessages>;

const localeMessages = [
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
  ["en", en],
  ["ja", ja],
  ["ko", ko],
  ["fr", fr],
  ["de", de],
  ["ru", ru],
  ["es", es],
  ["it", it],
  ["pt", pt],
  ["id", id],
  ["no", no],
  ["nl", nl],
  ["pl", pl],
  ["tr", tr],
  ["vi", vi]
] satisfies Array<[LocaleCode, Partial<LocaleMessages>]>;

test("all locales define playback mode messages", () => {
  for (const [locale, messages] of localeMessages) {
    for (const key of playbackMessageKeys) {
      assert.equal(typeof messages[key], "string", `${locale}.${key}`);
      assert.notEqual(messages[key], "", `${locale}.${key}`);
    }
  }
});
