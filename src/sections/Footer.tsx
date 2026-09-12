import { useState } from "react";
import { useLang, type Translations } from "@/lib/i18n";
import { Link } from "@/lib/router";

/**
 * The footer, built to the reference screenshot: a circular mark standing on the
 * page above a single wide coloured panel, split between a sign-up form and
 * three columns of links.
 *
 * The reference's red becomes this site's burgundy, and the monogram becomes the
 * real Holland mark on a cream disc — a burgundy disc would have swallowed a
 * logo that is itself red and blue.
 *
 * The Contact column carries what the removed Visit section used to: the shop's
 * two numbers and its address. Removing a section must not quietly remove the
 * only way to reach the business.
 */

const NAVIGATE: { href: string; label: keyof Translations }[] = [
  { href: "/", label: "footHome" },
  { href: "/menu", label: "footMenu" },
  { href: "/#craft", label: "footCraft" },
];

const SOCIALS = [
  { href: "https://www.instagram.com/", label: "Instagram" },
  { href: "https://www.facebook.com/", label: "Facebook" },
  { href: "https://wa.me/201016521650", label: "WhatsApp" },
];

/**
 * From the printed menu sheets.
 *
 * Not translated, and deliberately not: a phone number is dialled, not read.
 * Rendering these in Arabic-Indic digits would make them prettier in Arabic and
 * unusable to anyone copying one into a keypad, and `tel:` needs Latin digits
 * regardless. The address *is* translated, because that one is read aloud to a
 * driver.
 */
const PHONES = ["+20 101 652 1650", "+20 155 260 0633"];

export default function Footer() {
  const { t } = useLang();
  const [email, setEmail] = useState("");

  return (
    <footer className="site-footer">
      {/* The mark, standing on the page background above the panel. */}
      <Link href="/" className="footer-badge" aria-label={t.brandHome}>
        <picture>
          <source srcSet="/img/logo.webp" type="image/webp" />
          <img
            src="/img/logo.png"
            alt="Holland Cookies"
            width={577}
            height={303}
            loading="lazy"
            decoding="async"
          />
        </picture>
      </Link>

      <div className="footer-panel">
        <div className="footer-signup">
          {/*
            A real `mailto:` form, not a decorative one.
            There is no backend on this site and no mailing-list service wired
            up, so the honest options were to leave the field out or to make it
            do something that genuinely works. It opens a pre-addressed email.
            Point `action` at a real endpoint the day one exists — nothing else
            here needs to change.
          */}
          <form
            className="footer-form"
            action="mailto:orders@hollandcookies.example"
            method="post"
            encType="text/plain"
          >
            <label className="sr-only" htmlFor="footer-email">
              {t.footEmailLabel}
            </label>
            <input
              id="footer-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder={t.footEmailPlaceholder}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button type="submit">{t.footSubscribe}</button>
          </form>
          <p className="footer-consent">{t.footConsent}</p>
        </div>

        <div className="footer-links">
          <nav aria-labelledby="footer-navigate">
            <h2 id="footer-navigate">{t.footNavigate}</h2>
            <ul>
              {NAVIGATE.map((link) => (
                <li key={link.href}>
                  <Link href={link.href}>{t[link.label] as string}</Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-labelledby="footer-socials">
            <h2 id="footer-socials">{t.footSocials}</h2>
            <ul>
              {SOCIALS.map((link) => (
                <li key={link.label}>
                  <a href={link.href} target="_blank" rel="noopener noreferrer">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <section aria-labelledby="footer-contact">
            <h2 id="footer-contact">{t.footContact}</h2>
            <ul>
              {PHONES.map((phone) => (
                <li key={phone}>
                  <a href={`tel:${phone.replace(/\s/g, "")}`} dir="ltr">
                    {phone}
                  </a>
                </li>
              ))}
              <li className="footer-address">{t.footAddress}</li>
              <li>{t.footHours}</li>
            </ul>
          </section>
        </div>
      </div>

      <p className="footer-fineprint">{t.footCopyright(new Date().getFullYear())}</p>
    </footer>
  );
}
