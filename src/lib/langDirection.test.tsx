// @vitest-environment jsdom
//
// Opted in per-file rather than by changing the suite default: this is the only
// test here that needs a document, and the rest are pure and stay fast without
// one.
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageProvider, useLang } from "./i18n";

/**
 * When the document turns around.
 *
 * `dir` decides where every box on the page sits, so a component that measures
 * its own layout when the language changes is asking a question whose answer
 * depends entirely on whether the attribute has been written yet.
 *
 * It used to be written in the provider's `useEffect`, and a child's effects
 * run before its parent's — so every consumer that re-measured on `lang` did it
 * in the gap where the labels were already Arabic and the document was still
 * left-to-right. The menu's travelling indicator measured in that gap and
 * settled 939px away from the pill it belonged to, with the active label (white,
 * to sit on that indicator) left unreadable on the page background. Nothing
 * corrected it, because nothing had resized: only the direction had changed.
 *
 * These tests pin the ordering rather than the symptom, so any consumer that
 * measures on a language change is safe, not just the one that caught it.
 */

/** Records the document direction as a child sees it, in a layout effect. */
function DirectionProbe({ seen }: { seen: string[] }) {
  const { lang } = useLang();
  useLayoutEffect(() => {
    seen.push(`${lang}:${document.documentElement.dir}`);
  }, [lang]);
  return null;
}

function Switcher() {
  const { toggleLang, setLang, lang } = useLang();
  return (
    <>
      <button onClick={toggleLang}>toggle</button>
      <button onClick={() => setLang("ar")}>arabic</button>
      <span data-testid="lang">{lang}</span>
    </>
  );
}

// Unmounted by hand, and the document put back the way it was found. There is
// no global setup file here, so nothing does either automatically — and the
// provider seeds itself from `<html lang>`, which means one test's leftovers
// decide what language the next one starts in.
afterEach(() => {
  cleanup();
  document.documentElement.lang = "en";
  document.documentElement.dir = "ltr";
  try {
    localStorage.clear();
  } catch {
    // Storage is optional here, exactly as it is in the provider.
  }
});

describe("document direction", () => {
  it("is already right-to-left when a child measures after switching to Arabic", () => {
    const seen: string[] = [];
    const { getByText } = render(
      <LanguageProvider>
        <DirectionProbe seen={seen} />
        <Switcher />
      </LanguageProvider>,
    );

    act(() => getByText("toggle").click());

    // The assertion that matters: the direction the *child* saw, not the one
    // the document happens to have settled on by the time the test looks.
    expect(seen.at(-1)).toBe("ar:rtl");
  });

  it("turns back with the language", () => {
    const seen: string[] = [];
    const { getByText } = render(
      <LanguageProvider>
        <DirectionProbe seen={seen} />
        <Switcher />
      </LanguageProvider>,
    );

    act(() => getByText("toggle").click());
    act(() => getByText("toggle").click());

    expect(seen.at(-1)).toBe("en:ltr");
  });

  it("applies through setLang as well as the toggle", () => {
    const seen: string[] = [];
    const { getByText } = render(
      <LanguageProvider>
        <DirectionProbe seen={seen} />
        <Switcher />
      </LanguageProvider>,
    );

    act(() => getByText("arabic").click());

    expect(seen.at(-1)).toBe("ar:rtl");
    expect(document.documentElement.lang).toBe("ar");
  });
});
