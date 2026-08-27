import assert from "node:assert/strict";
import test from "node:test";
import type { HumanAssistanceContract } from "../human-assistance.ts";
import {
  createCaptchaSourceFreshnessStore,
  createLoadedCaptchaSourceOwner,
  type CaptchaImageDescriptor,
  type CaptchaSourceCapture,
  type CaptchaSourceOwner,
} from "./captcha-source-freshness.ts";

function contract(version = 1): HumanAssistanceContract {
  return {
    schemaVersion: 1,
    version,
    stageId: "captcha-stage",
    title: "Complete CAPTCHA",
    targets: [{
      id: "captcha-input",
      label: "CAPTCHA input",
      semanticId: "provider.login.captcha-input",
      modes: ["type"],
      rect: { x: 10, y: 20, width: 100, height: 24 },
    }],
    contextRegions: [],
    completion: { mode: "inline", targetIds: ["captcha-input"], status: "pending" },
    focus: { targetId: "captcha-input", contextRegionIds: [] },
    challengeKind: "text-captcha",
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "provider.login.captcha-image",
      rect: { x: 0, y: 0, width: 120, height: 40 },
    },
  };
}

function descriptor(
  source: unknown,
  overrides: Partial<CaptchaImageDescriptor> = {},
): CaptchaImageDescriptor {
  return {
    image: {
      evaluate: async () => source,
    } as never,
    rect: { x: 10, y: 20, width: 96, height: 28 },
    pageUrl: "https://provider.example/login",
    frameUrl: "https://provider.example/login",
    frameName: "top",
    markerKey: "test-captcha-marker",
    ...overrides,
  };
}

function source(
  image: Buffer | null,
  overrides: Partial<{
    sourceMarker: string;
    frameMarker: string;
    naturalWidth: number;
    naturalHeight: number;
  }> = {},
) {
  return {
    dataUrl: image
      ? `data:image/png;base64,${image.toString("base64")}`
      : null,
    sourceMarker: overrides.sourceMarker ?? "image-v1",
    frameMarker: overrides.frameMarker ?? "frame-v1",
    naturalWidth: overrides.naturalWidth ?? 120,
    naturalHeight: overrides.naturalHeight ?? 40,
  };
}

function sourceOwner(options: {
  source: () => unknown;
  descriptor?: () => CaptchaImageDescriptor;
  naturalWidth?: number;
  naturalHeight?: number;
}) {
  return createLoadedCaptchaSourceOwner({
    id: "test-source-owner",
    withPage: async (_session, action) => action({} as never),
    resolveImage: async () => options.descriptor?.() ?? descriptor(options.source()),
    naturalWidth: options.naturalWidth,
    naturalHeight: options.naturalHeight,
  });
}

test("loaded-image owner captures source pixels with calibrated geometry", async () => {
  const pixels = Buffer.from("source-pixels");
  const owner = sourceOwner({
    source: () => source(pixels),
    naturalWidth: 120,
    naturalHeight: 40,
  });
  const capture = await owner.capture("session", contract());
  assert.ok(capture);
  assert.deepEqual(capture.image, pixels);
  assert.equal(capture.fingerprint.naturalWidth, 120);
  assert.equal(capture.fingerprint.naturalHeight, 40);
  assert.ok(capture.fingerprint.imageHash);
});

test("source policy rejects unsupported natural geometry", async () => {
  const image = Buffer.from("css-sized");
  const owner = sourceOwner({
    source: () => source(image, { naturalWidth: 100, naturalHeight: 35 }),
    naturalWidth: 120,
    naturalHeight: 40,
  });
  assert.equal(await owner.capture("session", contract()), null);
});

test("source owner freshness compares URL, frame, source, rectangle, and image hash", async () => {
  let currentPixels = Buffer.from("pixels-v1");
  let currentSourceMarker = "image-v1";
  let currentFrameMarker = "frame-v1";
  let currentRect = { x: 10, y: 20, width: 96, height: 28 };
  let currentPageUrl = "https://provider.example/login";
  const owner = sourceOwner({
    source: () => source(currentPixels, {
      sourceMarker: currentSourceMarker,
      frameMarker: currentFrameMarker,
    }),
    descriptor: () => descriptor(source(currentPixels, {
      sourceMarker: currentSourceMarker,
      frameMarker: currentFrameMarker,
    }), {
      rect: currentRect,
      pageUrl: currentPageUrl,
    }),
  });
  const capture = await owner.capture("session", contract());
  assert.ok(capture);
  assert.equal(await owner.isCurrent("session", contract(), capture), true);

  const changes: Array<() => void> = [
    () => { currentPageUrl = "https://provider.example/other"; },
    () => { currentPageUrl = "https://provider.example/login"; currentFrameMarker = "frame-v2"; },
    () => { currentFrameMarker = "frame-v1"; currentSourceMarker = "image-v2"; },
    () => { currentSourceMarker = "image-v1"; currentRect = { x: 13, y: 20, width: 96, height: 28 }; },
    () => { currentRect = { x: 10, y: 20, width: 96, height: 28 }; currentPixels = Buffer.from("pixels-v2"); },
  ];
  for (const change of changes) {
    change();
    assert.equal(await owner.isCurrent("session", contract(), capture), false);
    currentPixels = Buffer.from("pixels-v1");
    currentSourceMarker = "image-v1";
    currentFrameMarker = "frame-v1";
    currentRect = { x: 10, y: 20, width: 96, height: 28 };
    currentPageUrl = "https://provider.example/login";
  }
});

function fakeOwner(
  id: string,
  current: boolean,
): CaptchaSourceOwner {
  const capture: CaptchaSourceCapture = {
    image: Buffer.from(id),
    fingerprint: {
      pageUrl: "page",
      frameUrl: "frame",
      frameIdentity: "identity",
      sourceMarker: "source",
      rect: { x: 0, y: 0, width: 1, height: 1 },
      imageHash: id,
    },
  };
  return {
    id,
    capture: async () => capture,
    isCurrent: async () => current,
  };
}

test("capture records are session/version/owner bound and single-use", async () => {
  const owner = fakeOwner("owner-a", true);
  const owners = new Map([[owner.id, owner]]);
  const store = createCaptchaSourceFreshnessStore((ownerId) => owners.get(ownerId) ?? null);
  assert.deepEqual(await store.capture("session", contract(), owner), Buffer.from("owner-a"));
  assert.equal(await store.isCurrent("session", contract()), true);
  assert.equal(await store.isCurrent("session", contract()), false);

  assert.deepEqual(await store.capture("session", contract(), owner), Buffer.from("owner-a"));
  assert.equal(await store.isCurrent("session", contract(2)), false);

  assert.deepEqual(await store.capture("session", contract(), owner), Buffer.from("owner-a"));
  owners.clear();
  assert.equal(await store.isCurrent("session", contract()), false);
});

test("capture failure clears any prior record", async () => {
  let succeeds = true;
  const owner: CaptchaSourceOwner = {
    id: "flaky-owner",
    capture: async () => succeeds
      ? {
          image: Buffer.from("image"),
          fingerprint: {
            pageUrl: "page",
            frameUrl: "frame",
            frameIdentity: "identity",
            sourceMarker: "source",
            rect: { x: 0, y: 0, width: 1, height: 1 },
          },
        }
      : null,
    isCurrent: async () => true,
  };
  const store = createCaptchaSourceFreshnessStore((ownerId) => ownerId === owner.id ? owner : null);
  await store.capture("session", contract(), owner);
  succeeds = false;
  assert.equal(await store.capture("session", contract(), owner), null);
  assert.equal(await store.isCurrent("session", contract()), false);
});
