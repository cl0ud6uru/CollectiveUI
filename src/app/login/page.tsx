import { redirect } from "next/navigation";
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
    <main className="login-page dark">
      <a href="#sign-in" className="login-skip">Skip to sign in</a>
      <LoginMoodProvider><div className="login-shell">
        <div className="login-aurora" aria-hidden="true"><span /><span /><span /></div>
        <StorySpotlight />
        <div className="login-brand"><BrandMark logoUrl={branding.logoUrl} logoEmoji={branding.logoEmoji} className="h-7 w-7 rounded-lg" /><span>{branding.appName}</span></div>
        <section className="login-content" aria-labelledby="sign-in-title">
          <BotConstellation><LoginCompanion pet={pet} /></BotConstellation>
          <h1 id="sign-in-title">{revealWords("Welcome back")}</h1>
          <p className="login-headline">{branding.loginHeadline}</p>
          <div className="login-form-wrap" id="sign-in" tabIndex={-1}>
            {preview && <p className="login-preview" role="status">Admin preview · You’re still signed in.</p>}
            <LoginForm callbackUrl={callbackUrl} entra={entraEnabled()} ldap={ldapEnabled()} local={localEnabled()} error={error ? "Sign-in failed. Please try again or contact IT." : undefined} />
          </div>
        </section>
        {pet.appearance === "catalog" && pet.credit && <p className="login-credit">{pet.name} · {pet.credit}</p>}
      </div></LoginMoodProvider>
    </main>
  );
}

/** Wraps each word for the staggered headline reveal; whitespace is kept, so the accessible text is unchanged. */
function revealWords(text: string) {
  let i = 0;
  return text.split(/(\s+)/).map((part, key) => (/^\s*$/.test(part) ? part : <span key={key} className="login-word" style={{ "--i": i++ } as React.CSSProperties}>{part}</span>));
}
