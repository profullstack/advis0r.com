/**
 * Transactional email for verification and password reset (PRD v3 §7).
 *
 * Resend is the primary transport with Mailgun as a fallback, selected by which
 * credential is present. When neither is configured the mailer degrades to a
 * logging no-op that returns the link — so signup still works in development
 * without silently pretending an email was delivered.
 *
 * Sender domain matters: Resend rejects a `from` address on a domain that is
 * not verified in the account. `advis0r.com` is registered but unverified
 * (DNS records not yet published), so `MAIL_FROM` defaults to an
 * already-verified domain and can be pointed at advis0r.com once its DNS is in
 * place.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailResult {
  ok: boolean;
  transport: "resend" | "mailgun" | "logged";
  id?: string;
  error?: string;
}

export interface MailerOptions {
  resendApiKey?: string;
  mailgunApiKey?: string;
  mailgunDomain?: string;
  from?: string;
  /** Base URL used to build links in emails. */
  appUrl?: string;
}

export const DEFAULT_FROM = "advis0r <noreply@profullstack.com>";

export class Mailer {
  constructor(private opts: MailerOptions = {}) {}

  get from(): string {
    return this.opts.from || DEFAULT_FROM;
  }

  get transport(): MailResult["transport"] {
    if (this.opts.resendApiKey) return "resend";
    if (this.opts.mailgunApiKey && this.opts.mailgunDomain) return "mailgun";
    return "logged";
  }

  get configured(): boolean {
    return this.transport !== "logged";
  }

  async send(msg: MailMessage): Promise<MailResult> {
    switch (this.transport) {
      case "resend":
        return this.sendResend(msg);
      case "mailgun":
        return this.sendMailgun(msg);
      default:
        // Never claim success for an email that was not sent.
        console.warn(`[mail] no transport configured — not sending "${msg.subject}" to ${msg.to}`);
        return { ok: false, transport: "logged", error: "no email transport configured" };
    }
  }

  private async sendResend(msg: MailMessage): Promise<MailResult> {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.resendApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        return {
          ok: false,
          transport: "resend",
          error: String(body?.message ?? body?.name ?? res.status).slice(0, 300),
        };
      }
      return { ok: true, transport: "resend", id: String(body?.id ?? "") };
    } catch (err) {
      return { ok: false, transport: "resend", error: String(err).slice(0, 300) };
    }
  }

  private async sendMailgun(msg: MailMessage): Promise<MailResult> {
    try {
      const form = new FormData();
      form.append("from", this.from);
      form.append("to", msg.to);
      form.append("subject", msg.subject);
      form.append("text", msg.text);
      form.append("html", msg.html);
      const auth = Buffer.from(`api:${this.opts.mailgunApiKey}`).toString("base64");
      const res = await fetch(
        `https://api.mailgun.net/v3/${this.opts.mailgunDomain}/messages`,
        {
          method: "POST",
          headers: { Authorization: `Basic ${auth}` },
          body: form,
          signal: AbortSignal.timeout(20_000),
        },
      );
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return {
          ok: false,
          transport: "mailgun",
          error: String(body?.message ?? res.status).slice(0, 300),
        };
      }
      return { ok: true, transport: "mailgun", id: String(body?.id ?? "") };
    } catch (err) {
      return { ok: false, transport: "mailgun", error: String(err).slice(0, 300) };
    }
  }
}

/* ---------- message templates ---------- */

function shell(title: string, body: string, cta: { url: string; label: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#0a0e14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#d7dee8">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px">
    <div style="font-size:20px;font-weight:600;letter-spacing:-.01em;margin-bottom:24px">advis0r<span style="opacity:.5">.com</span></div>
    <h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(title)}</h1>
    <p style="line-height:1.6;margin:0 0 24px;color:#a8b3c1">${body}</p>
    <a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#2f81f7;color:#fff;text-decoration:none;padding:11px 18px;border-radius:7px;font-weight:500">${escapeHtml(cta.label)}</a>
    <p style="margin:24px 0 0;font-size:12px;color:#6b7684;line-height:1.6">If the button does not work, paste this into your browser:<br><span style="color:#8b95a5;word-break:break-all">${escapeHtml(cta.url)}</span></p>
    <hr style="border:0;border-top:1px solid #1c2430;margin:24px 0">
    <p style="font-size:12px;color:#6b7684;margin:0;line-height:1.6">advis0r.com is a research aid, not financial advice. If you did not request this email you can safely ignore it.</p>
  </div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export function verificationEmail(url: string, expiresHours: number): Omit<MailMessage, "to"> {
  return {
    subject: "Verify your advis0r.com email",
    text: `Confirm your email address to finish setting up your advis0r.com account:\n\n${url}\n\nThis link expires in ${expiresHours} hours. If you did not sign up, ignore this email.`,
    html: shell(
      "Confirm your email address",
      `Click below to finish setting up your advis0r.com account. This link expires in ${expiresHours} hours.`,
      { url, label: "Verify email" },
    ),
  };
}

export function resetEmail(url: string, expiresMinutes: number): Omit<MailMessage, "to"> {
  return {
    subject: "Reset your advis0r.com password",
    text: `Reset your advis0r.com password:\n\n${url}\n\nThis link expires in ${expiresMinutes} minutes and can be used once. If you did not request a reset, ignore this email — your password is unchanged.`,
    html: shell(
      "Reset your password",
      `Click below to choose a new password. This link expires in ${expiresMinutes} minutes and can only be used once. If you did not request a reset, your password is unchanged.`,
      { url, label: "Reset password" },
    ),
  };
}
