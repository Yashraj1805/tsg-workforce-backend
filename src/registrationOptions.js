// Fixed choices for the registration screens (BRD §10) and the consent notice (§9, §10
// screen 4). Jobs are a database master (System Admin edits them); these lists are short
// and stable enough to live in code.

// Screen 10: "Education — one choice."
const EDUCATION = [
  { id: 'none', en: 'No schooling', hi: 'स्कूल नहीं गए', icon: '✋' },
  { id: 'primary', en: 'Up to 5th', hi: '5वीं तक', icon: '✏️' },
  { id: '8th', en: '8th pass', hi: '8वीं पास', icon: '📗' },
  { id: '10th', en: '10th pass', hi: '10वीं पास', icon: '📘' },
  { id: '12th', en: '12th pass', hi: '12वीं पास', icon: '📙' },
  { id: 'iti', en: 'ITI / Diploma', hi: 'आईटीआई / डिप्लोमा', icon: '🛠️' },
  { id: 'graduate', en: 'Graduate or above', hi: 'ग्रेजुएट या ऊपर', icon: '🎓' },
];

// Design rule 3/5: experience as a tap, not typed.
const EXPERIENCE = [
  { id: '0-1', en: 'New / under 1 year', hi: 'नया / 1 साल से कम', icon: '🌱' },
  { id: '1-3', en: '1 – 3 years', hi: '1 – 3 साल', icon: '⭐' },
  { id: '3-5', en: '3 – 5 years', hi: '3 – 5 साल', icon: '⭐⭐' },
  { id: '5+', en: 'More than 5 years', hi: '5 साल से ज़्यादा', icon: '🏆' },
];

// DPDP Act 2023 notice + consent. DRAFT — BRD §9: "Legal team to confirm before go-live".
// Bump CONSENT.version whenever the text changes; workers who accepted an older version
// are asked again at their next registration submit.
const CONSENT = {
  version: 'v1-draft-2026-10',
  en: 'The Sachdev Group (TSG) will collect your mobile number, photo, Aadhaar (masked number and verification result only — never the full number), PAN, vendor, job and education, and your location and selfie only at the moment you punch in or out. This is used only to verify your identity, record your attendance and pay your vendor for days worked. Your data is stored in India, kept secure, and shared only with the KYC verification provider and your vendor\'s payment check. You can ask TSG HR to see or correct your data, or withdraw consent; withdrawing means you can no longer punch attendance. I agree.',
  hi: 'द सचदेव ग्रुप (TSG) आपका मोबाइल नंबर, फोटो, आधार (सिर्फ़ छुपा हुआ नंबर और जाँच का नतीजा — पूरा नंबर कभी नहीं), पैन, वेंडर, काम और पढ़ाई की जानकारी लेगा, और आपकी लोकेशन व सेल्फ़ी सिर्फ़ हाज़िरी लगाते समय। इसका उपयोग सिर्फ़ आपकी पहचान जाँचने, हाज़िरी दर्ज करने और काम किए गए दिनों के लिए आपके वेंडर को भुगतान करने के लिए होगा। आपका डेटा भारत में सुरक्षित रखा जाएगा और सिर्फ़ केवाईसी जाँच करने वाली कंपनी और वेंडर भुगतान जाँच के साथ साझा होगा। आप TSG HR से अपना डेटा देखने, सुधारने या सहमति वापस लेने को कह सकते हैं; सहमति वापस लेने पर आप हाज़िरी नहीं लगा पाएँगे। मैं सहमत हूँ।',
};

module.exports = { EDUCATION, EXPERIENCE, CONSENT };
