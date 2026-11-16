//page texts: one language pack per file in ./locales, English is the reference (same languages as the wallet)
//a new language = a new locales/<code>.ts with every key of en.ts, plus one line in each list below
//Texts take {name} placeholders; counts are a Plural with the forms the language needs (Intl.PluralRules)
//English is in the main bundle; every other pack loads when it is first picked (loadLang), English shows meanwhile
import { createContext, useContext } from 'react';
import { en, type Plural, type Texts } from './locales/en';

//name of each language in itself, in the order the picker shows them
export const languages = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fil: 'Filipino',
  fr: 'Français',
  hr: 'Hrvatski',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  nl: 'Nederlands',
  pl: 'Polski',
  pt: 'Português',
  tr: 'Türkçe',
} as const;
export type Lang = keyof typeof languages;
export type { Plural, Texts };

const loaders: Record<Exclude<Lang, 'en'>, () => Promise<Texts>> = {
  de: () => import('./locales/de').then((m) => m.de),
  es: () => import('./locales/es').then((m) => m.es),
  fil: () => import('./locales/fil').then((m) => m.fil),
  fr: () => import('./locales/fr').then((m) => m.fr),
  hr: () => import('./locales/hr').then((m) => m.hr),
  id: () => import('./locales/id').then((m) => m.id),
  it: () => import('./locales/it').then((m) => m.it),
  nl: () => import('./locales/nl').then((m) => m.nl),
  pl: () => import('./locales/pl').then((m) => m.pl),
  pt: () => import('./locales/pt').then((m) => m.pt),
  tr: () => import('./locales/tr').then((m) => m.tr),
};
const loaded: Partial<Record<Lang, Texts>> = { en };

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && v in languages;

//the pack ready to use; true once it is (a failed load keeps English)
export async function loadLang(lang: Lang): Promise<boolean> {
  if (loaded[lang]) {
    return true;
  }
  try {
    loaded[lang] = await loaders[lang as Exclude<Lang, 'en'>]();
    return true;
  } catch {
    return false;
  }
}
export const langReady = (lang: Lang) => !!loaded[lang];

//browser language when we have it (tl = Tagalog, the base of Filipino), else English
export function defaultLang(): Lang {
  const code = (navigator.language ?? 'en').toLowerCase().split('-')[0] ?? 'en';
  const lang = code === 'tl' ? 'fil' : code;
  return isLang(lang) ? lang : 'en';
}

export function fill(text: string, vars?: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (vars && k in vars ? String(vars[k]) : m));
}

export interface Tr {
  lang: Lang;
  t: Texts;
  //fill a text's placeholders
  f: (text: string, vars?: Record<string, string | number>) => string;
  //a count: the plural form for n, {n} and the other placeholders filled
  p: (forms: Plural, n: number, vars?: Record<string, string | number>) => string;
}

export function translator(lang: Lang): Tr {
  const rules = new Intl.PluralRules(lang === 'fil' ? 'fil' : lang);
  return {
    lang,
    t: loaded[lang] ?? en,
    f: fill,
    p: (forms, n, vars) => fill(forms[rules.select(n) as keyof Plural] ?? forms.other, { n, ...vars }),
  };
}

//the language for code outside React (swap and offer texts made in lib/): App sets it whenever it changes
let current = translator(defaultLang());
export const setCurrentLang = (lang: Lang) => {
  current = translator(lang);
};
export const T = () => current;

export const LangContext = createContext<Tr>(current);
export const useT = () => useContext(LangContext);
