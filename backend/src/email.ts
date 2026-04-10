import nodemailer from "nodemailer";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:7777";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? "localhost",
  port: Number(process.env.SMTP_PORT ?? 1025),
  secure: process.env.SMTP_SECURE === "true",
  ...(process.env.SMTP_USER
    ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? "" } }
    : {}),
});

const FROM = process.env.EMAIL_FROM ?? "Flakey <noreply@flakey.dev>";

/**
 * Generic email sender used by the scheduled-reports dispatcher and any other
 * system-initiated notifications.
 */
export async function sendEmail(opts: { to: string; subject: string; text: string; html?: string }): Promise<void> {
  await transporter.sendMail({ from: FROM, ...opts });
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const url = `${FRONTEND_URL}/verify-email/${token}`;
  await transporter.sendMail({
    from: FROM,
    to,
    subject: "Verify your email — Flakey",
    text: `Verify your email by visiting: ${url}\n\nThis link expires in 24 hours.`,
    html: `
      <h2>Verify your email</h2>
      <p>Click the link below to verify your email address:</p>
      <p><a href="${url}">Verify Email</a></p>
      <p>This link expires in 24 hours.</p>
      <p>If you didn't create an account, you can ignore this email.</p>
    `,
  });
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const url = `${FRONTEND_URL}/reset-password/${token}`;
  await transporter.sendMail({
    from: FROM,
    to,
    subject: "Reset your password — Flakey",
    text: `Reset your password by visiting: ${url}\n\nThis link expires in 1 hour.`,
    html: `
      <h2>Reset your password</h2>
      <p>Click the link below to reset your password:</p>
      <p><a href="${url}">Reset Password</a></p>
      <p>This link expires in 1 hour.</p>
      <p>If you didn't request this, you can ignore this email.</p>
    `,
  });
}
