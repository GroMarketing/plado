// POST /api/stripe-webhook: Stripe events for the Plado sponsor payment link. Events for any
// other payment link are ignored.
// Env: STRIPE_WEBHOOK_SECRET (whsec_...), SPONSOR_LINK_ID (plink_...).
import { checkSponsor } from './_sponsor-rules.js';

const HOLD_MS = 48 * 3600 * 1000;
const SLOTS = 4;
const enc = new TextEncoder();

async function verify(raw, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')).filter((p) => p.length === 2 && p[0] !== 'v1'));
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300 || !sigs.length) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${raw}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
  return sigs.some((s) => same(s, hex));
}

const field = (s, k) => (s.custom_fields || []).find((f) => f.key === k)?.text?.value || '';

export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  if (!(await verify(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) return new Response('bad signature', { status: 400 });
  const ev = JSON.parse(raw), o = ev.data?.object || {};
  if (!env.DB) return new Response('no db', { status: 500 });

  if (ev.type === 'checkout.session.completed') {
    if (!env.SPONSOR_LINK_ID || o.payment_link !== env.SPONSOR_LINK_ID) return new Response('ignored');
    const now = Date.now(), c = checkSponsor({ name: field(o, 'name'), url: field(o, 'link'), tagline: field(o, 'tagline') });
    const taken = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sponsors WHERE status IN ('ok','unpaid','paused')").first())?.n || 0;
    // rejected and sold-out rows are never shown; the daily review flags them for a refund
    const status = !c.ok ? 'rejected' : taken >= SLOTS ? 'rejected' : o.payment_status === 'paid' ? 'ok' : 'unpaid';
    const reason = !c.ok ? c.reason : taken >= SLOTS ? 'sold out' : null;
    await env.DB.prepare('INSERT OR IGNORE INTO sponsors (id, subscription, name, url, tagline, email, status, reason, created_at, live_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)')
      .bind(o.id, o.subscription || null, c.name || field(o, 'name') || '(none)', c.url || field(o, 'link') || '', c.tagline ?? field(o, 'tagline'), o.customer_details?.email || null, status, reason, now, now + HOLD_MS).run();
    return new Response('ok');
  }
  if (ev.type === 'checkout.session.async_payment_succeeded') {
    await env.DB.prepare("UPDATE sponsors SET status = 'ok' WHERE id = ?1 AND status = 'unpaid'").bind(o.id).run();
    return new Response('ok');
  }
  if (ev.type === 'checkout.session.async_payment_failed') {
    await env.DB.prepare("UPDATE sponsors SET status = 'canceled', reason = 'payment failed' WHERE id = ?1 AND status = 'unpaid'").bind(o.id).run();
    return new Response('ok');
  }
  if (ev.type.startsWith('customer.subscription.')) {
    // only rows already in the table (bought through the sponsor link) can match
    const st = ev.type === 'customer.subscription.deleted' || ['canceled', 'unpaid', 'incomplete_expired'].includes(o.status) ? 'canceled'
      : ['active', 'trialing'].includes(o.status) && !o.pause_collection ? 'ok' : 'paused';
    await env.DB.prepare("UPDATE sponsors SET status = ?1 WHERE subscription = ?2 AND status IN ('ok','paused')").bind(st, o.id).run();
    return new Response('ok');
  }
  return new Response('ignored');
}
