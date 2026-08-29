import { useLang } from "@/lib/i18n";

/**
 * `EN | AR`.
 *
 * Two buttons rather than one toggle. A single button has to be labelled with
 * either the language you are in or the language you would get, and both
 * readings are common enough that some proportion of people press it expecting
 * the opposite of what happens. Showing both options and marking the current
 * one removes the question.
 *
 * Each label is written in its own language and carries `lang` to match, so a
 * screen reader pronounces "العربية" in Arabic rather than spelling it out
 * through an English voice — and so a reader who cannot read the current
 * language can still find their own.
 */
export default function LangSwitch({ className = "" }: { className?: string }) {
  const { lang, setLang, t } = useLang();

  return (
    <div className={`lang-switch ${className}`} role="group" aria-label={t.langSwitch}>
      <button
        type="button"
        className={`lang-opt ${lang === "en" ? "is-active" : ""}`}
        // The current language is a state, not a destination. `aria-current`
        // says "you are here"; disabling it instead would take it out of the
        // tab order and hide the fact that a choice exists at all.
        aria-current={lang === "en" ? "true" : undefined}
        lang="en"
        onClick={() => setLang("en")}
      >
        EN
      </button>
      <span className="lang-sep" aria-hidden="true">
        |
      </span>
      <button
        type="button"
        className={`lang-opt ${lang === "ar" ? "is-active" : ""}`}
        aria-current={lang === "ar" ? "true" : undefined}
        lang="ar"
        onClick={() => setLang("ar")}
      >
        AR
      </button>
    </div>
  );
}
