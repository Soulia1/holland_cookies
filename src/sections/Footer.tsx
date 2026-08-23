const LINKS = [
  { href: "#menu", label: "Menu" },
  { href: "#craft", label: "Our Craft" },
  { href: "#visit", label: "Visit" },
];

export default function Footer() {
  return (
    <footer className="bg-soft-oat w-full py-16 md:py-20 border-t border-outline-variant/30">
      <div className="max-w-[1440px] mx-auto flex flex-col md:flex-row justify-between items-start px-5 md:px-12 gap-8">
        <div>
          <a href="#top" className="block mb-5" aria-label="Holland Cookies, back to top">
            <img
              src="/img/logo.jpg"
              alt="Holland Cookies"
              className="h-9 md:h-10 w-auto opacity-80 hover:opacity-100 transition-opacity duration-300"
              width={140}
              height={40}
              loading="lazy"
            />
          </a>
          <p className="font-body text-[16px] leading-[26px] text-on-surface-variant">
            © {new Date().getFullYear()} Holland Cookies. Baked fresh, always.
          </p>
        </div>

        <nav className="flex flex-wrap gap-6 md:gap-12" aria-label="Footer">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="font-body text-[16px] leading-[26px] text-on-surface-variant hover:text-deep-burgundy transition-colors duration-300"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
