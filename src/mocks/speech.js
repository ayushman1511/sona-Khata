// MOCK speech. There is NO speech recognition and NO text-to-speech model here.
//  - "ASR": the user types (or the demo injects) what the karigar "said". A keyword matcher maps it to an intent.
//  - "TTS": the message is shown as text with a speaker label.
// Planned replacement: an Indic ASR/TTS model (Bhashini or AI4Bharat), evaluated on real recordings.
// Every Hindi/Bengali keyword below needs a native-speaker check before any field use.

export const IS_MOCK = true;
export const LABEL = 'MOCK SPEECH: typed text stands in for voice, keyword matcher, no ASR/TTS';

const YES = ['haan', 'ha', 'haa', 'hanji', 'ji haan', 'theek hai', 'thik hai', 'sahi hai', 'yes', 'ok', 'okay', 'हाँ', 'हां', 'जी हाँ', 'ठीक है', 'सही है', 'হ্যাঁ', 'ঠিক আছে'];
const NO = ['nahi', 'nahin', 'na', 'galat', 'no', 'wrong', 'नहीं', 'गलत', 'না', 'ভুল'];

/** Map a transcript to an intent: {intent:'approve'|'reject'|'progress'|'unknown', text, grams?} */
export function mockUnderstand(transcript) {
  const t = String(transcript ?? '').trim().toLowerCase().replace(/[.!?।]+$/u, '');
  if (!t) return { intent: 'unknown', text: t };
  const has = (list) => list.some((w) => t === w || t.startsWith(w + ' ') || t.startsWith(w + ','));
  // Check "no" first: "nahi, theek nahi hai" must not read as yes.
  if (has(NO) || /\b(nahi|nahin|galat)\b/.test(t) || /নয়|না\b|नहीं/u.test(t)) return { intent: 'reject', text: t };
  if (has(YES)) return { intent: 'approve', text: t };
  const g = /(\d+(?:\.\d{1,3})?)\s*(g|gm|gram|grams|ग्राम)/iu.exec(t);
  return { intent: 'progress', text: t, ...(g ? { gramsMentioned: g[1] } : {}) };
}
