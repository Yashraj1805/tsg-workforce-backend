// Automated face checks using Gemini's vision capability — an LLM judgment call, not a
// certified biometric face-match/liveness API. No accuracy guarantee, no anti-spoofing
// certification, and it sends worker face photos to Google's API. This is a pragmatic
// stopgap because getting a real biometric vendor is a slower procurement decision
// (see the Setu thread) — swap this for a dedicated face-match API if/when one is
// sourced. Confirmed against Gemini's actual current REST API docs on 2026-09-30
// (ai.google.dev/api/generate-content, ai.google.dev/gemini-api/docs/structured-output).
//
// Two separate checks, kept deliberately separate:
//  - detectFace: fast, single-image "is a face framed here" check, polled every couple
//    of seconds while the live camera preview is open, to auto-trigger capture without
//    the worker tapping a shutter button.
//  - compareFaces: the actual identity check (does this match the registration photo),
//    run once against the frame detectFace locked onto, as part of the punch itself.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
// GEMINI_BASE_URL is only for pointing at a proxy or a local test stub.
const ENDPOINT = `${process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'}/v1beta/models/${MODEL}:generateContent`;

function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Expected a data: URL image');
  return { mimeType: m[1], data: m[2] };
}

async function callGemini(promptText, images, schema, timeoutMs) {
  if (!isConfigured()) return { ok: false, skipped: true, error: 'GEMINI_API_KEY not configured' };

  const body = {
    contents: [{
      parts: [
        { text: promptText },
        ...images.map(img => ({ inline_data: { mime_type: img.mimeType, data: img.data } })),
      ],
    }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: schema,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(`${ENDPOINT}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || `Gemini API error (${res.status})`);
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned no content');
    return { ok: true, ...JSON.parse(text) };
  } catch (e) {
    return { ok: false, skipped: false, error: e.name === 'AbortError' ? 'Gemini request timed out' : e.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function compareFaces(registrationPhotoDataUrl, selfieDataUrl) {
  const ref = parseDataUrl(registrationPhotoDataUrl);
  const shot = parseDataUrl(selfieDataUrl);
  return callGemini(
    'You are an anti-fraud check for a workplace attendance app. The first image is a worker\'s verified registration photo. The second image is a live selfie just captured at punch-in/out. IMPORTANT: the capture pipeline for the second image does not correct orientation, so it may be rotated 90 degrees or fully upside down — mentally reorient it and judge purely on facial identity, never treat rotation/orientation alone as evidence of a different person. Decide whether the second image shows the same person as the first. Separately, flag if the second image looks like a photo of a screen or printed photo rather than a real live camera capture (screen glare, moire pattern, device bezel visible, unnatural flatness) — that would indicate someone is trying to spoof the check; orientation alone is not a spoofing signal.',
    [ref, shot],
    {
      type: 'object',
      properties: {
        samePerson: { type: 'boolean', description: 'true if both images show the same person' },
        confidence: { type: 'number', description: '0 to 1, how confident you are in the samePerson judgement' },
        spoofSuspected: { type: 'boolean', description: 'true if the second image looks like a photo of a screen/photo rather than a live capture' },
        reason: { type: 'string', description: 'one short sentence explaining the judgement' },
      },
      required: ['samePerson', 'confidence', 'spoofSuspected', 'reason'],
    },
    12000
  );
}

async function detectFace(frameDataUrl) {
  const frame = parseDataUrl(frameDataUrl);
  return callGemini(
    'This is a low-res frame from a live front-camera preview, used only to auto-trigger a selfie capture for a workplace attendance app — a real identity check runs separately afterward on a full-quality photo, so this is just a quick "is a face roughly here" gate, not the actual verification. Say yes as long as a human face is visibly present anywhere in the frame, even if off-center, partially cropped, at an angle, dim, or rotated/upside-down (the capture pipeline does not correct orientation — ignore rotation entirely). Only say no if the frame is clearly empty, pointed at a wall/ceiling/object, or totally dark/blurry with no face visible at all. Default to yes when in doubt.',
    [frame],
    {
      type: 'object',
      properties: {
        faceDetected: { type: 'boolean', description: 'true if one clear live human face is framed and ready to capture' },
        reason: { type: 'string', description: 'very short reason, e.g. "no face", "too dark", "looks good"' },
      },
      required: ['faceDetected', 'reason'],
    },
    6000
  );
}

// BRD R04: PAN is captured as a photo, not typed. This reads the card; the number it
// returns is then verified against the Income Tax records through Setu (kyc.js), so an
// OCR misread fails verification rather than registering a wrong PAN.
async function readPanCard(photoDataUrl) {
  const photo = parseDataUrl(photoDataUrl);
  return callGemini(
    'This is a phone camera photo of what should be an Indian PAN card (Permanent Account Number card issued by the Income Tax Department). It may be rotated, angled or slightly blurred. Read it. The PAN is exactly 10 characters: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F) — read it character by character, distinguishing 0/O, 1/I, 5/S, 8/B by position (positions 1-5 and 10 are letters, 6-9 are digits). If it is not a PAN card (e.g. an Aadhaar card, a screen, a blank photo), set isPanCard false and leave the other fields empty. ' +
    'Separately, look for signs of digital editing or forgery: inconsistent fonts or letter spacing within the printed text, a visibly pasted/cloned photo or text block, mismatched lighting/sharpness between the photo and the card body, or edge/halo artifacts around text — as opposed to normal photo noise, glare, creases or wear on a genuine physical card, which are NOT signs of forgery. Only flag tamperSuspected when something looks actually edited, not just low quality.',
    [photo],
    {
      type: 'object',
      properties: {
        isPanCard: { type: 'boolean', description: 'true only if this is a photo of an Indian PAN card' },
        panNumber: { type: 'string', description: 'the 10-character PAN in upper case, or empty' },
        nameOnCard: { type: 'string', description: 'cardholder name as printed, or empty' },
        fatherName: { type: 'string', description: "father's name as printed, or empty" },
        dob: { type: 'string', description: 'date of birth as printed (DD/MM/YYYY), or empty' },
        confidence: { type: 'number', description: '0 to 1, how sure you are the PAN was read correctly' },
        tamperSuspected: { type: 'boolean', description: 'true only if there are actual visible signs of digital editing/forgery, not just low photo quality' },
        tamperNote: { type: 'string', description: 'one short reason if tamperSuspected, else empty' },
      },
      required: ['isPanCard', 'panNumber', 'nameOnCard', 'confidence', 'tamperSuspected'],
    },
    15000
  );
}

// R06 duplicate-face check: one new registrant photo vs a handful of existing workers'
// photos in a single call. Returns the 1-based index of the matching candidate, or 0.
async function findMatchingFace(probeDataUrl, candidateDataUrls) {
  const probe = parseDataUrl(probeDataUrl);
  const cands = candidateDataUrls.map(parseDataUrl);
  return callGemini(
    `Duplicate-registration check for a workplace ID system. The FIRST image is a new registrant's live photo. The next ${cands.length} images are existing registered people, numbered 1 to ${cands.length} in order. Photos may be rotated, differently lit or taken years apart. Decide whether any numbered person is the SAME PERSON as the first image, judging facial identity only (not clothes, background, glasses or hairstyle). Most of the time none match — answer 0 unless you are genuinely confident.`,
    [probe, ...cands],
    {
      type: 'object',
      properties: {
        matchIndex: { type: 'integer', description: `1-${cands.length} for the matching person, 0 if none match` },
        confidence: { type: 'number', description: '0 to 1, confidence in the matchIndex answer' },
        reason: { type: 'string', description: 'one short sentence' },
      },
      required: ['matchIndex', 'confidence', 'reason'],
    },
    20000
  );
}

// BRD §10 screen 5: registration photo must show exactly one live person.
async function checkRegistrationPhoto(photoDataUrl) {
  return callGemini(
    'This is the registration photo for a workplace ID system, taken live with a phone camera. It may be rotated (ignore orientation). Count the human faces clearly visible, and judge whether it is a photo of a real live person in front of the camera, as opposed to a photo of a printed picture, an ID card, or a phone/computer screen (look for screen glare, moire, bezels, paper edges, unnatural flatness).',
    [parseDataUrl(photoDataUrl)],
    {
      type: 'object',
      properties: {
        faceCount: { type: 'integer', description: 'number of human faces clearly visible' },
        isLivePerson: { type: 'boolean', description: 'true if this is a live person, not a photo of a photo/card/screen' },
        confidence: { type: 'number', description: '0 to 1, confidence in this assessment' },
        reason: { type: 'string', description: 'one short sentence' },
      },
      required: ['faceCount', 'isLivePerson', 'confidence', 'reason'],
    },
    12000
  );
}

// Text-only Gemini call (no images) — the AI assistant (services/aiAssistant.js) uses
// this for both routing a question to a report and writing the natural-language answer.
async function ask(promptText, schema, timeoutMs) {
  return callGemini(promptText, [], schema, timeoutMs);
}

module.exports = { compareFaces, detectFace, readPanCard, findMatchingFace, checkRegistrationPhoto, ask, isConfigured };
