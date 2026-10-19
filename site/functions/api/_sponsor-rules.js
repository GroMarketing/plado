// Automatic content rules for sponsor slots. Anything that fails is never shown and is
// flagged for a refund by the daily review. Rules catch accidents and lazy abuse; the
// person reviewing during the 48-hour hold is the real control.
const BANNED = /\bw[e3]b ?3\b|\bcrypto|cryptocurrenc|bitcoin|\bbtc\b|ethereum|\beth\b|\bnfts?\b|\bweb ?3\b|\bdefi\b|token ?sale|airdrop|memecoin|\bcoins?\b|solana|\bsol\b|binance|\busdt\b|tether|\bdoge|shiba|kripto|staking|casino|sportsbook|\bwager|roulette|blackjack|gambl|poker|lotter|porn|\badult\b|\bxxx\b|nsfw|onlyfans|\bescorts?\b|\bdating\b|hookup|\bloans?\b|payday|forex|\bcbd\b|\bvapes?\b|steroid/;
// the same words with separators removed, for "C.a.s.i.n.o" and zero-width splits
const BANNED_JOINED = /crypto|bitcoin|\bbtc|casino|sportsbook|roulette|blackjack|gambl|porn|onlyfans|memecoin|airdrop|binance|tether|solana|payday|forex/;
// Platform names a sponsor may not use in its name or link, so nobody can look like
// Anthropic, OpenAI, Google, Cursor, xAI, GitHub or Plado.
const PLATFORMS = /anthropic|claude|openai|chatgpt|codex|cursor|google|gemini|xai|grok|github|copilot|plado/;
// In the one-line description, naming a platform is fine ("works with GitHub Actions");
// claiming to be it, or to be endorsed by it, is not.
const CLAIM = /\b(by|from|official|officially|partner(ed)?( with| of)?|endorsed( by)?|certified( by)?|approved( by)?|powered by|team|made by|built by)\b\W*(anthropic|claude|openai|chatgpt|google|gemini|cursor|xai|grok|github|copilot|plado)\b|\bofficial\b/;
const digits = (s, one) => s.replace(/[0134578@$]/g, (c) => ({ 0: 'o', 1: one, 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's' }[c]));
const lower = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[​-‏⁠﻿]/g, '');
// separators inside a word are dropped ("C-l-a-u-d-e", "C.a.s.i.n.o"); spaces between words stay
const joined = (s) => s.replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ');

export function checkSponsor({ name, url, tagline }) {
  name = String(name || '').trim(); tagline = String(tagline || '').trim(); url = String(url || '').trim();
  if (!name || name.length > 40) return { ok: false, reason: 'name missing or over 40 characters' };
  if (tagline.length > 90) return { ok: false, reason: 'tagline over 90 characters' };
  // plain printable ASCII only in what we display: no look-alike letters from other scripts
  if (/[^\x20-\x7e]/.test(name.normalize('NFKC')) || /[^\x20-\x7e]/.test(tagline.normalize('NFKC'))) return { ok: false, reason: 'name and line must use plain letters (A-Z), digits and punctuation' };
  let u; try { u = new URL(url); } catch { return { ok: false, reason: 'link is not a valid URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'link must be https' };
  if (/^\d+\.\d+\.\d+\.\d+$|^\[/.test(u.hostname) || !u.hostname.includes('.')) return { ok: false, reason: 'link must be a domain name' };
  if (u.hostname.split('.').some((l) => l.startsWith('xn--'))) return { ok: false, reason: 'link uses a look-alike (punycode) domain' };
  if (u.username || u.password) return { ok: false, reason: 'link has credentials in it' };
  const link = lower(`${u.hostname} ${decodeURIComponent(u.pathname + u.search + u.hash)}`);
  const all = lower(`${name} ${tagline}`) + ' ' + link;
  // banned categories: as written, with look-alike digits mapped, and with separators removed
  for (const t of [all, digits(all, 'i'), digits(all, 'l')]) {
    if (BANNED.test(t) || BANNED_JOINED.test(joined(t))) return { ok: false, reason: 'banned category (crypto, adult, gambling, lending)' };
  }
  // platform names in the name or link (also with separators removed: "C-l-a-u-d-e", "C1aude")
  const id = lower(name) + ' ' + link;
  for (const t of [id, digits(id, 'i'), digits(id, 'l')]) {
    if (PLATFORMS.test(t.replace(/[^a-z]+/g, ' ')) || PLATFORMS.test(joined(t))) return { ok: false, reason: 'uses a platform name' };
  }
  for (const t of [lower(tagline), digits(lower(tagline), 'i'), digits(lower(tagline), 'l')]) if (CLAIM.test(t)) return { ok: false, reason: 'claims to be or be endorsed by a platform' };
  return { ok: true, name, url: u.toString(), tagline };
}
