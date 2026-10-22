import { describe, expect, it } from 'vitest';
import { assembleLetter, checkAnswers, checkLetter, checkOpening, computeBid, contactDetailsIn, countSentences, swapLoomLink } from '../src/pipeline/letter';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

const s = (bid: Partial<Settings['bid']> = {}): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), bid: { hourly: 'client_max', fixed: 'client_budget', profileRate: 0, ...bid } });

const TEMPLATE = `Hi there,

{opening}

I recorded a quick Loom for you explaining exactly how I'd grow your email revenue: {loom_link}

My Visual Flow Framework
https://miro.com/app/board/uXjVJnINQFw=/

Talk soon,
Rafa`;
const OPENING = 'Your welcome and browse-abandonment flows are the fastest wins here, and I would start by rebuilding both in Klaviyo.';
const LOOM = 'https://www.loom.com/share/de64065f88f648be910277062a18e601';

describe('assembleLetter', () => {
  it('puts the opening and the Loom link in place and keeps the rest word for word', () => {
    const letter = assembleLetter(TEMPLATE, OPENING, LOOM);
    expect(letter).toBe(TEMPLATE.replace('{opening}', OPENING).replace('{loom_link}', LOOM));
    expect(checkLetter(letter, LOOM)).toBeNull();
  });
  it('drops the Loom line when there is no video yet', () => {
    const letter = assembleLetter(TEMPLATE, OPENING, null);
    expect(letter).not.toContain('Loom');
    expect(letter).toContain('My Visual Flow Framework');
  });
  it('puts the opening first when the template has no {opening}', () => {
    expect(assembleLetter('Talk soon,\nRafa', OPENING, null)).toBe(`${OPENING}\n\nTalk soon,\nRafa`);
  });
  it('rejects letters over 5,000 characters', () => {
    expect(checkLetter('x'.repeat(5001), null)).toMatch(/longer than 5000/);
  });
});

describe('checkOpening', () => {
  it('accepts a normal opening', () => expect(checkOpening(OPENING)).toBeNull());
  it('rejects links, contact details, placeholders and bad lengths', () => {
    expect(checkOpening(`${OPENING} See www.example.com for more.`)).toBe('the opening contains a link');
    expect(checkOpening(`${OPENING} Email me at rafa@example.com.`)).toMatch(/link|email/);
    expect(checkOpening(`${OPENING} Call +1 415 555 0100.`)).toBe('the opening contains a phone number');
    expect(checkOpening(`${OPENING} {loom_link}`)).toBe('the opening contains a template placeholder');
    expect(checkOpening('Too short.')).toBe('the opening is too short');
    expect(checkOpening('a'.repeat(601))).toMatch(/longer than 600/);
  });
});

describe('checkAnswers', () => {
  it('needs one clean answer per question', () => {
    const q = ['How many Klaviyo accounts have you managed?', 'What is your availability?'];
    expect(checkAnswers(q, [{ question: q[0], answer: 'Dozens over 9 years.' }, { question: q[1], answer: 'Happy to discuss on a call.' }])).toBeNull();
    expect(checkAnswers(q, [{ question: q[0], answer: 'Dozens.' }])).toMatch(/expected 2 answers/);
    expect(checkAnswers(q.slice(0, 1), [{ question: q[0], answer: 'See my site rafa.com' }])).toBe('an answer contains a link');
  });
});

describe('computeBid', () => {
  it('hourly: top of the client range, else the profile rate', () => {
    expect(computeBid('hourly', '10.00–30.00/hr', s())).toBe(30);
    expect(computeBid('hourly', '30.00+/hr', s())).toBe(30);
    expect(computeBid('hourly', '', s({ profileRate: 45 }))).toBe(45);
    expect(computeBid('hourly', '', s())).toBeNull();
    expect(computeBid('hourly', '10.00–30.00/hr', s({ hourly: 'profile', profileRate: 45 }))).toBe(45);
  });
  it('fixed: the budget, or budget + 10%', () => {
    expect(computeBid('fixed', '200.00', s())).toBe(200);
    expect(computeBid('fixed', '200.00', s({ fixed: 'budget_plus_10' }))).toBe(220);
    expect(computeBid('fixed', '', s())).toBeNull();
  });
});

describe('contactDetailsIn', () => {
  it('flags contact details but not the template links', () => {
    expect(contactDetailsIn('Reach me on WhatsApp')).toBe('a social handle or outside contact link');
    expect(contactDetailsIn('https://gamma.app/docs/Rafa-Email-Design-Samples-t4tjgljjfjmu5ad')).toBeNull();
  });
});

describe('disclosure', () => {
  it('appends the AI disclosure line only when given', () => {
    expect(assembleLetter('Hi,\n\n{opening}', OPENING, null, 'Drafted with AI assistance and reviewed by me.')).toBe(`Hi,\n\n${OPENING}\n\nDrafted with AI assistance and reviewed by me.`);
    expect(assembleLetter('Hi,\n\n{opening}', OPENING, null, null)).toBe(`Hi,\n\n${OPENING}`);
  });
});

describe('sentence limit', () => {
  // The first real opening (Oct 21): 4 sentences, repeating the template's claims.
  const real = "Your Shopify store's email setup likely has gaps in its flows that are costing you revenue, and finding them is exactly what a good Klaviyo audit should do. I'd review your current flows and strategy, flag what's missing or underperforming, and give you clear, practical recommendations, then help implement them. As a Klaviyo Master Certified Partner with 9+ years in the platform, I focus on getting email to drive 30-50% of total store revenue.";
  it('counts sentences without splitting numbers or abbreviations', () => {
    expect(countSentences(real)).toBe(3);
    expect(countSentences(`${real} Let's talk.`)).toBe(4);
    expect(countSentences('Revenue grew 4.5x in Q2, e.g. from flows. That is the goal.')).toBe(2);
  });
  it('rejects openings over 3 sentences', () => {
    expect(checkOpening(`${OPENING} Second one here. Third one here. Fourth one here.`)).toBe('the opening has 4 sentences (max 3)');
    expect(checkOpening(`${OPENING} Second one here.`)).toBeNull();
  });
});

describe('swapLoomLink', () => {
  it('replaces any Loom share link with the current video, leaving other links alone', () => {
    const NEW = 'https://www.loom.com/share/eea7d413d42f4c1ebb726c188f54ea74';
    const letter = 'Hi,\n\nLoom: https://www.loom.com/share/de64065f88f648be910277062a18e601?sid=abc\n\nhttps://miro.com/app/board/uXjVJnINQFw=/';
    expect(swapLoomLink(letter, NEW)).toBe(`Hi,\n\nLoom: ${NEW}\n\nhttps://miro.com/app/board/uXjVJnINQFw=/`);
    expect(swapLoomLink('No video here.', NEW)).toBe('No video here.');
  });
});
