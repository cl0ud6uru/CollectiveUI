import { redirect } from "next/navigation";
import { ArrowUpRight, LockKeyhole } from "lucide-react";
import { auth } from "@/auth";
import { entraEnabled, localEnabled } from "@/lib/auth/config";
import { BrandMark } from "@/components/brand-mark";
import { ldapEnabled } from "@/lib/auth/ldap";
import { safeCallback } from "@/lib/auth/callback";
import { getPrincipal } from "@/lib/session";
import { getPublicLoginPet } from "@/lib/branding/login-pet";
import { getPublicBranding } from "@/lib/branding/store";
import { LoginForm } from "./login-form";
import { BotConstellation } from "./bot-constellation";
import { LoginCompanion } from "./login-companion";
import { LoginMoodProvider } from "./login-mood";
import { StorySpotlight } from "./story-spotlight";
import "./login.css";

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const callbackUrl = safeCallback(sp.callbackUrl);
  if ((await auth())?.user?.mustChangePassword) redirect("/account/password");
  const principal = await getPrincipal();
  const preview = principal?.isAdmin && sp.preview === "1";
  if (principal && !preview) redirect(callbackUrl);
  const [branding, pet] = await Promise.all([getPublicBranding(), getPublicLoginPet()]);
  const error = typeof sp.error === "string" ? sp.error : undefined;

  return (
    <main className="login-page">
      <a href="#sign-in" className="login-skip">Skip to sign in</a>
      <LoginMoodProvider><div className="login-layout">
        <section className="login-story" aria-label="Your AI workspace">
          <div className="login-aurora" aria-hidden="true"><span /><span /><span /></div>
          <StorySpotlight />
          <div className="login-brand"><BrandMark logoUrl={branding.logoUrl} logoEmoji={branding.logoEmoji} className="h-10 w-10" /><span>{branding.appName}</span></div>
          <div className="login-story-content">
            <BotConstellation><LoginCompanion pet={pet} /></BotConstellation>
            <div className="login-eyebrow"><span /> YOUR COLLECTIVE ADVANTAGE</div>
            <h1>{revealWords(branding.loginHeadline)}</h1>
            <p className="login-description">{branding.loginDescription}</p>
          </div>
          <div className="login-story-footer"><span>{pet.appearance === "catalog" && pet.credit ? `${pet.name} · ${pet.credit}` : "Built for ideas. Ready for what’s next."}</span><ArrowUpRight aria-hidden="true" size={18} /></div>
        </section>
        <section className="login-entry" aria-labelledby="sign-in-title">
          <div className="login-form-wrap" id="sign-in" tabIndex={-1}>
            {preview && <p className="login-preview" role="status">Admin preview · You’re still signed in.</p>}
            <div className="login-form-kicker"><span aria-hidden="true" />LET’S GET STARTED</div>
            <h2 id="sign-in-title">Welcome back.</h2>
            <p className="login-form-description">Sign in to <strong>{branding.appName}</strong> with your {localEnabled() ? "account" : "company account"}.</p>
            <LoginForm callbackUrl={callbackUrl} entra={entraEnabled()} ldap={ldapEnabled()} local={localEnabled()} error={error ? "Sign-in failed. Please try again or contact IT." : undefined} />
            <div className="login-security"><LockKeyhole aria-hidden="true" size={15} /><span>Your {localEnabled() ? "account" : "company account"}. Your workspace.</span></div>
          </div>
          <p className="login-entry-footer">A little intelligence. A lot of possibility.</p>
        </section>
      </div></LoginMoodProvider>
    </main>
  );
}

/** Wraps each word for the staggered headline reveal; whitespace is kept, so the accessible text is unchanged. */
function revealWords(text: string) {
  let i = 0;
  return text.split(/(\s+)/).map((part, key) => (/^\s*$/.test(part) ? part : <span key={key} className="login-word" style={{ "--i": i++ } as React.CSSProperties}>{part}</span>));
}
