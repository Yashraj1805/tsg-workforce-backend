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
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

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

module.exports = { compareFaces, detectFace, isConfigured };
