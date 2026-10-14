import type { DefaultCategoryId } from "../db.js";

/**
 * Simple keyword rules mapping a merchant / description to one of the seeded category ids.
 * First match wins, so more specific rules come first. Matching is case- and accent-insensitive.
 */
const RULES: [DefaultCategoryId, RegExp][] = [
  ["restaurant", /\b(wolt|foodora|bolt food|mcdonald'?s?|burger king|kfc|subway|starbucks|costa coffee|pizza|bistro|restaurant|etterem|vendeglo|cafe|kavezo|cukraszda|pekseg|gyros|sushi|kebab)\b/],
  ["groceries", /\b(spar|interspar|tesco|lidl|aldi|auchan|penny|coop|cba|prima|real|kifli\.?hu|match|fresh ?market|nagybani|piac|grocery|supermarket|elelmiszer)\b/],
  ["transport", /\b(bkk|bkv|mav|volan|uber|bolt|freenow|taxi|mol|omv|shell|lukoil|parkolas|parking|nemzeti mobilfizetesi|e-?matrica|autopalya)\b/],
  ["subscriptions", /\b(netflix|spotify|youtube|disney|hbo|max\.com|apple\.com|icloud|google (one|storage|play)|microsoft|xbox game pass|chatgpt|openai|anthropic|claude\.ai|github|dropbox|adobe|patreon|duolingo)\b/],
  ["utilities", /\b(mvm|elmu|emasz|fogaz|fotav|dijnet|vizmu|vizmuvek|digi|telekom|vodafone|yettel|one hungary|upc|internet|aram|gaz)\b/],
  ["housing", /\b(alberlet|berleti dij|rent|kozos koltseg|tarsashaz|ikea|obi|praktiker|bauhaus|jysk|mobelix)\b/],
  ["health", /\b(patika|gyogyszertar|pharmacy|benu|dm|rossmann|fogorvos|dentist|orvos|klinika|medicover|labor)\b/],
  ["clothing", /\b(h&m|h & m|zara|reserved|deichmann|decathlon|about you|c&a|pull&bear|bershka|primark|sinsay|mango|zalando|humanic)\b/],
  ["travel", /\b(airbnb|booking\.com|ryanair|wizz ?air|easyjet|lufthansa|hotel|hostel|szallas\.hu|flixbus|szallas)\b/],
  ["entertainment", /\b(cinema city|mozi|steam|playstation|nintendo|jegy\.hu|ticketmaster|eventim|muzeum|museum|szinhaz|koncert|bowling|escape)\b/],
];

const strip = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // combining diacritical marks

export function categorize(description: string, amount: number, type?: string): DefaultCategoryId | null {
  const text = strip(description);
  for (const [cat, re] of RULES) if (re.test(text)) return cat;
  const t = (type ?? "").toUpperCase();
  if (amount > 0 && t !== "CARD_REFUND" && t !== "REFUND") return "income";
  if (t === "ATM") return "other";
  return null;
}
