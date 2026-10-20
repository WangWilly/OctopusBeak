import { decodeGrayImage, encodeGrayImage, upscaleImage, type GrayImage } from "./captcha-preprocess.ts";

type CharacterRecognition = Readonly<{ answer: string; confidence: number }>;

/** The fixed Rakuten pipeline validated on 123 selection and 60 held-out images.
 * Input is the already extracted black foreground. Cuts use pixels only.
 * Four bounded OCR calls form one declared strategy, never four agreeing votes. */
export async function recognizeRakutenCharacters(
  processed: Buffer,
  recognize: (image: Buffer) => Promise<CharacterRecognition>,
): Promise<{ text: string; confidence: number }> {
  const image = decodeGrayImage(processed);
  const empty = { text: "", confidence: 0 };
  if (image.width !== 152 || image.height !== 60) return empty;
  const projection = new Uint16Array(image.width);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[y * image.width + x] === 0) projection[x]! += 1;
    }
  }
  if (!projection.some((ink) => ink > 0)) return empty;
  const cuts = [0];
  // 152/4 = 38 px per slot; search ±floor(38*0.36) = 13 px.
  for (let index = 1; index < 4; index += 1) {
    const target = index * 38;
    let bestCut = target;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let cut = target - 13; cut <= target + 13; cut += 1) {
      const cost = (projection[cut - 1]! + projection[cut]!) * 4 + ((cut - target) / 13) ** 2;
      if (cost < bestCost) {
        bestCut = cut;
        bestCost = cost;
      }
    }
    cuts.push(bestCut);
  }
  cuts.push(image.width);
  const characters: CharacterRecognition[] = [];
  for (let index = 0; index < 4; index += 1) {
    const crop = cropCharacter(image, cuts[index]!, cuts[index + 1]!);
    if (!crop) return empty;
    characters.push(await recognize(encodeGrayImage(crop)));
  }
  if (characters.some(({ answer }) => answer.length !== 1)) return empty;
  return {
    text: characters.map(({ answer }) => answer).join(""),
    confidence: characters.reduce((sum, { confidence }) => sum + confidence, 0) / 4,
  };
}

function cropCharacter(image: GrayImage, start: number, end: number): GrayImage | null {
  let left = end;
  let right = -1;
  let top = image.height;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = start; x < end; x += 1) {
      if (image.data[y * image.width + x] !== 0) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return null;
  const width = right - left + 1;
  const height = bottom - top + 1;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    data.set(image.data.subarray((top + y) * image.width + left, (top + y) * image.width + right + 1), y * width);
  }
  const scaled = upscaleImage({ width, height, data }, 2);
  const padded = {
    width: scaled.width + 20,
    height: scaled.height + 20,
    data: new Uint8Array((scaled.width + 20) * (scaled.height + 20)).fill(255),
  };
  for (let y = 0; y < scaled.height; y += 1) {
    padded.data.set(scaled.data.subarray(y * scaled.width, (y + 1) * scaled.width), (y + 10) * padded.width + 10);
  }
  return padded;
}
