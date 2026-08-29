import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLang } from "@/lib/i18n";

/**
 * Sign in with an emailed code.
 *
 * Two steps on one surface: the address, then the six digits sent to it. No
 * password — which removes an entire class of problem, since there is nothing
 * to reuse across sites, nothing to leak and nothing to reset.
 *
 * The resend cooldown is mirrored here from the server's own sixty seconds
 * (`otp.js`), so the button is disabled rather than pressed into an error. The
 * server is still the one enforcing it; this is only politeness.
 */

const RESEND_COOLDOWN_SECONDS = 60;

export default function SignInSheet({ onDone }: { onDone?: (linked: number) => void }) {
  const { t, lang } = useLang();
  const { signIn, mailConfigured } = useAuth();

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const codeRef = useRef<HTMLInputElement>(null);

  // Counts the resend cooldown down to zero. Cleared on unmount so a sheet
  // closed mid-countdown leaves no interval running.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  // Focus follows the step, so the customer is typing into the field that just
  // appeared rather than hunting for it.
  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  async function sendCode(event?: React.FormEvent) {
    event?.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.requestCode(email.trim(), lang);
      setStep("code");
      setCooldown(RESEND_COOLDOWN_SECONDS);
      // Said plainly rather than hidden: in development the code goes to the
      // server log, and a customer staring at an inbox that will never receive
      // anything is the worst possible version of this screen.
      if (!result.delivered) setNotice(t.acDevNotice);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "COOLDOWN") {
        setStep("code");
        setCooldown(Number((caught as ApiError & { retryAfter?: number }).retryAfter) || RESEND_COOLDOWN_SECONDS);
      }
      setError(caught instanceof ApiError ? caught.message : t.ckGenericError);
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.verifyCode(email.trim(), code.trim());
      signIn(result.customer);
      onDone?.(result.linkedOrders);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t.ckGenericError);
      setCode("");
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  if (step === "email") {
    return (
      <form onSubmit={sendCode} noValidate>
        <span className="ed-tag">{t.acSignInTitle}</span>
        <h1 className="ed-title" style={{ marginBlockEnd: 14 }}>{t.acSignInTitle}</h1>
        <p className="ed-note" style={{ marginBlockEnd: 30 }}>{t.acSignInIntro}</p>

        <div className="ed-field">
          <label className="ed-label" htmlFor="signin-email">{t.acEmail}</label>
          <input id="signin-email" className="ed-input" type="email" inputMode="email" dir="ltr"
            autoComplete="email" autoFocus value={email}
            onChange={(event) => setEmail(event.target.value)} />
        </div>

        {error && <p className="ed-alert" role="alert">{error}</p>}
        {!mailConfigured && <p className="ed-note">{t.acDevNotice}</p>}

        <button type="submit" className="ed-btn" disabled={busy || !email.trim()}>
          {busy ? t.acSending : t.acSendCode}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={verify} noValidate>
      <span className="ed-tag">{t.acSignInTitle}</span>
      <h1 className="ed-title" style={{ marginBlockEnd: 14 }}>{t.acCodeTitle}</h1>
      <p className="ed-note" style={{ marginBlockEnd: 30 }} dir="auto">
        {t.acCodeIntro(email.trim())}
      </p>

      <div className="ed-field">
        <label className="ed-label" htmlFor="signin-code">{t.acCode}</label>
        {/* `inputMode="numeric"` and `one-time-code`: on a phone this brings up
            the digit pad, and iOS offers the code straight from the mail
            notification without the customer switching apps. */}
        <input
          ref={codeRef}
          id="signin-code"
          className="ed-input"
          dir="ltr"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
          style={{ letterSpacing: "0.4em", fontSize: 20 }}
        />
      </div>

      {notice && <p className="ed-note">{notice}</p>}
      {error && <p className="ed-alert" role="alert">{error}</p>}

      <button type="submit" className="ed-btn" disabled={busy || code.length < 6}>
        {busy ? t.acVerifying : t.acVerify}
      </button>

      <button type="button" className="ed-ghost" disabled={busy || cooldown > 0}
        onClick={() => sendCode()}>
        {cooldown > 0 ? t.acResendIn(cooldown) : t.acResend}
      </button>
      <button type="button" className="ed-ghost" style={{ marginBlockStart: 4 }}
        onClick={() => { setStep("email"); setCode(""); setError(null); setNotice(null); }}>
        {t.acWrongEmail}
      </button>
    </form>
  );
}
