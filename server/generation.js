import { PNG } from "pngjs";

export const styles = {
  claymation:
    "Handmade stop-motion claymation. Tactile plasticine, visible fingerprints, soft studio lighting.",
  watercolor:
    "Cozy watercolor illustration. Translucent pigments, soft bleeding edges, textured watercolor paper.",
  cinematic:
    "Spooky cinematic creature portrait. Dramatic moody lighting, richly detailed organic pumpkin material, charming rather than gory.",
  crochet:
    "Crochet plushie. Clearly visible interlocking yarn stitches, stuffed amigurumi construction, soft wool and sewn facial features.",
};
export const characters = {
  original: "The pumpkin creature itself, without a costume.",
  knight: "A tiny pumpkin knight with miniature armor and a little shield.",
  swamp: "A pumpkin swamp monster with moss and little swamp-grown details.",
  explorer: "A pumpkin space explorer with a small space suit and helmet.",
  aristocrat:
    "An elegant pumpkin aristocrat with a refined little jacket and cravat.",
};
export class GenerationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function validateRequest(body) {
  if (
    !body ||
    !Object.hasOwn(styles, body.style) ||
    !Object.hasOwn(characters, body.character) ||
    typeof body.keepWeirdness !== "boolean"
  ) {
    throw new GenerationError(
      400,
      "Choose a valid style, character, and weirdness setting.",
    );
  }
  if (
    typeof body.sketch !== "string" ||
    body.sketch.length > 1_400_000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.sketch)
  ) {
    throw new GenerationError(400, "Send a PNG sketch under 1 MB.");
  }
  let image;
  try {
    const bytes = Buffer.from(body.sketch.split(",")[1], "base64");
    // Inspect dimensions before decoding, so a tiny compressed upload cannot allocate a huge bitmap.
    if (
      bytes.length < 24 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) !== 1024 ||
      bytes.readUInt32BE(20) !== 1024
    )
      throw new Error();
    image = PNG.sync.read(bytes, { checkCRC: true });
  } catch {
    throw new GenerationError(
      400,
      "The sketch must be a valid 1024 × 1024 PNG.",
    );
  }
  let ink = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const [r, g, b, a] = image.data.subarray(i, i + 4);
    if (a > 30 && Math.min(r, g, b) < 180) ink++;
  }
  if (ink < 16) throw new GenerationError(400, "Add a little scribble first.");
  return body;
}

export function buildPrompt({ style, character, keepWeirdness }) {
  return [
    "Transform the supplied pumpkin sketch into one polished pumpkin character. The image is a structural reference, not something to ignore.",
    styles[style],
    characters[character],
    "Keep the exact framing, subject center, size, silhouette, pose and position from the sketch. Keep the full creature inside the image. Use a warm cream background with a subtle ground shadow. No text, watermark, border or additional creatures.",
    keepWeirdness
      ? "KEEP MY WEIRDNESS: preserve asymmetry and every distinctive quirk. Match the stem length and bend, relative eye sizes and placement, mouth shape, lopsided body, and unusual proportions. Do not correct, beautify, symmetrize or replace those details. Add polish through material and lighting, not by redesigning the drawing."
      : "Use the sketch as the starting character. Gently refine rough lines and balance facial proportions, while keeping the recognizable silhouette, composition and personality.",
    "Costumes and accessories must follow the existing silhouette and never hide the eyes, mouth or stem.",
  ].join("\n");
}

export async function generateImage(
  body,
  {
    apiKey,
    model = "gpt-image-2",
    fetchImpl = fetch,
    signal,
    onUsage,
    onRejected,
  } = {},
) {
  if (!apiKey)
    throw new GenerationError(
      503,
      "Live generation needs a server API key. You can still draw and watch the demo.",
    );
  const response = await fetchImpl("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      images: [{ image_url: body.sketch }],
      prompt: buildPrompt(body),
      n: 1,
      size: "1024x1024",
      quality: "medium",
      output_format: "png",
    }),
    signal,
  });
  if (!response.ok) {
    // Explicit request rejections did not produce an image. Release only the
    // pending marker; retain all previously observed tokens. Ambiguous failures
    // (timeouts, transport errors, 5xx) still fail closed in the caller.
    if ([400, 401, 403, 422, 429].includes(response.status)) onRejected?.();
    if (response.status === 429) {
      const details = await response.json().catch(() => null);
      const code = details?.error?.code;
      const quotaMessage =
        "OpenAI API credits or quota are exhausted. Check API billing and available credits, then retry.";
      const spendMessage =
        "OpenAI rejected the request because the API organization or project reached its spend limit. Check the corresponding limit in OpenAI settings before retrying.";
      const rateMessage =
        "OpenAI is temporarily rate-limiting image requests. Wait briefly before trying again.";
      const messages = {
        insufficient_quota: quotaMessage,
        credit_balance_exhausted: quotaMessage,
        organization_spend_limit_exceeded: spendMessage,
        project_spend_limit_exceeded: spendMessage,
        organization_usage_limit_exceeded:
          "The OpenAI API account reached its usage limit. Check the account limits in OpenAI settings before retrying.",
        rate_limit_exceeded: rateMessage,
        slow_down: rateMessage,
      };
      const message =
        typeof code === "string" && Object.hasOwn(messages, code)
          ? messages[code]
          : details?.error?.type === "insufficient_quota"
            ? quotaMessage
            : details?.error?.type === "rate_limit_error"
              ? rateMessage
              : "OpenAI rejected the image request due to an API rate or quota limit. Check API billing and usage limits before retrying.";
      throw new GenerationError(429, message);
    }
    if ([400, 422].includes(response.status))
      throw new GenerationError(
        422,
        "The image service could not transform this sketch. Try a simpler drawing or another style.",
      );
    if ([401, 403].includes(response.status))
      throw new GenerationError(
        503,
        "The server could not access image generation. Check its API key and model access.",
      );
    throw new GenerationError(
      502,
      "The image service is unavailable. Your sketch is safe; please try again.",
    );
  }
  const result = await response.json();
  onUsage?.(result.usage);
  const encoded = result.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new GenerationError(
      502,
      "The image service returned no usable image. Please try again.",
    );
  return { image: `data:image/png;base64,${encoded}` };
}
