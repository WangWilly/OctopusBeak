import { createHash } from "node:crypto";
import type {
  HumanAssistanceContract,
  HumanVerificationRect,
} from "../human-assistance.ts";
import type { ViewerPageAccess } from "./automation-viewer.ts";

/** A locator-backed image source that can be inspected without exposing Page. */
export type CaptchaImageDescriptor = {
  image: ReturnType<ViewerPageAccess["locator"]>;
  rect: HumanVerificationRect;
  pageUrl: string;
  frameUrl: string;
  frameName: string;
  /** A stable key scoped to the page/frame whose value identifies the source. */
  markerKey: string;
};

type CaptchaImageSource = {
  dataUrl: string | null;
  sourceMarker: string;
  frameMarker: string;
  naturalWidth: number;
  naturalHeight: number;
};

type CaptchaSourceFingerprint = {
  pageUrl: string;
  frameUrl: string;
  frameIdentity: string;
  sourceMarker: string;
  rect: HumanVerificationRect;
  naturalWidth?: number;
  naturalHeight?: number;
  imageHash?: string;
};

export type CaptchaSourceCapture = {
  image: Buffer;
  fingerprint: CaptchaSourceFingerprint;
};

export type CaptchaSourceOwner = {
  id: string;
  capture(
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<CaptchaSourceCapture | null>;
  isCurrent(
    session: string,
    contract: HumanAssistanceContract,
    capture: CaptchaSourceCapture,
  ): Promise<boolean>;
};

type CaptchaSourceOwnerFactoryOptions = {
  id: string;
  naturalWidth?: number;
  naturalHeight?: number;
  withPage: CaptchaSourcePageRunner;
  resolveImage(
    page: ViewerPageAccess,
    contract: HumanAssistanceContract,
  ): Promise<CaptchaImageDescriptor | null>;
};

type CaptchaSourcePageRunner = <T>(
  session: string,
  action: (page: ViewerPageAccess) => Promise<T>,
) => Promise<T>;

type CaptchaSourceCaptureRecord = {
  session: string;
  stageId: string;
  contractVersion: number;
  ownerId: string;
  capture: CaptchaSourceCapture;
};

type CaptchaSourceFreshnessStore = {
  capture(
    session: string,
    contract: HumanAssistanceContract,
    owner: CaptchaSourceOwner,
  ): Promise<Buffer | null>;
  /** Validate and consume the capture record. Missing records are stale. */
  isCurrent(session: string, contract: HumanAssistanceContract): Promise<boolean>;
  clear(session: string): void;
};

type CaptchaSourceOwnerResolver = (
  ownerId: string,
  contract: HumanAssistanceContract,
) => CaptchaSourceOwner | null;

function rectMatches(left: HumanVerificationRect, right: HumanVerificationRect) {
  return Math.abs(left.x - right.x) <= 1
    && Math.abs(left.y - right.y) <= 1
    && Math.abs(left.width - right.width) <= 1
    && Math.abs(left.height - right.height) <= 1;
}

function hashImage(image: Buffer) {
  return createHash("sha256").update(image).digest("hex");
}

function imageFromDataUrl(dataUrl: unknown): Buffer | null {
  if (typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match?.[1]) return null;
  try {
    const image = Buffer.from(match[1], "base64");
    return image.length > 0 ? image : null;
  } catch {
    return null;
  }
}

/**
 * Read the loaded image bytes and source identity from one live DOM image.
 * This is deliberately the only DOM-to-pixels operation used by source
 * owners; callers may choose to fail closed when dataUrl is unavailable.
 */
async function inspectCaptchaImageSource(
  descriptor: CaptchaImageDescriptor,
): Promise<CaptchaImageSource | null> {
  return descriptor.image.evaluate((node, key) => {
    if (!(node instanceof HTMLImageElement)) return null;
    const windowRecord = window as typeof window & Record<string, unknown>;
    const existingMarker = windowRecord[key];
    const frameMarker = typeof existingMarker === "string"
      ? existingMarker
      : `${Date.now()}-${Math.random()}`;
    windowRecord[key] = frameMarker;
    const sourceMarker = () => JSON.stringify({
      frameMarker,
      href: document.location.href,
      src: node.getAttribute("src"),
      currentSrc: node.currentSrc,
      id: node.id,
      className: node.className,
      naturalWidth: node.naturalWidth,
      naturalHeight: node.naturalHeight,
    });
    if (!node.complete || node.naturalWidth <= 0 || node.naturalHeight <= 0) {
      return {
        dataUrl: null,
        frameMarker,
        sourceMarker: sourceMarker(),
        naturalWidth: node.naturalWidth,
        naturalHeight: node.naturalHeight,
      };
    }
    const canvas = document.createElement("canvas");
    canvas.width = node.naturalWidth;
    canvas.height = node.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    let dataUrl: string | null = null;
    try {
      context.drawImage(node, 0, 0, node.naturalWidth, node.naturalHeight);
      dataUrl = canvas.toDataURL("image/png");
    } catch {
      // The source marker still lets the caller detect a replacement, but
      // an owner that requires loaded pixels must reject this capture.
    }
    return {
      dataUrl,
      frameMarker,
      sourceMarker: sourceMarker(),
      naturalWidth: node.naturalWidth,
      naturalHeight: node.naturalHeight,
    };
  }, descriptor.markerKey).catch(() => null) as Promise<CaptchaImageSource | null>;
}

function fingerprintForCaptchaCapture(input: {
  descriptor: CaptchaImageDescriptor;
  source: CaptchaImageSource;
  image?: Buffer;
}): CaptchaSourceFingerprint {
  return {
    pageUrl: input.descriptor.pageUrl,
    frameUrl: input.descriptor.frameUrl,
    frameIdentity: `${input.descriptor.frameName}|${input.descriptor.frameUrl}|${input.source.frameMarker}`,
    sourceMarker: input.source.sourceMarker,
    rect: { ...input.descriptor.rect },
    ...(input.source.naturalWidth > 0 ? { naturalWidth: input.source.naturalWidth } : {}),
    ...(input.source.naturalHeight > 0 ? { naturalHeight: input.source.naturalHeight } : {}),
    ...(input.image ? { imageHash: hashImage(input.image) } : {}),
  };
}

function fingerprintMatches(
  current: CaptchaSourceFingerprint,
  expected: CaptchaSourceFingerprint,
) {
  return current.pageUrl === expected.pageUrl
    && current.frameUrl === expected.frameUrl
    && current.frameIdentity === expected.frameIdentity
    && current.sourceMarker === expected.sourceMarker
    && rectMatches(current.rect, expected.rect)
    && current.naturalWidth === expected.naturalWidth
    && current.naturalHeight === expected.naturalHeight
    && current.imageHash === expected.imageHash;
}

function geometryMatches(
  source: CaptchaImageSource,
  policy: { naturalWidth?: number; naturalHeight?: number },
) {
  return (policy.naturalWidth === undefined || source.naturalWidth === policy.naturalWidth)
    && (policy.naturalHeight === undefined || source.naturalHeight === policy.naturalHeight);
}

/**
 * Build a provider-owned source adapter. Provider code supplies only the
 * image resolver and calibration policy; pixel extraction and freshness are
 * kept behind this module's interface.
 */
export function createLoadedCaptchaSourceOwner(
  options: CaptchaSourceOwnerFactoryOptions,
): CaptchaSourceOwner {
  const inspect = async (
    session: string,
    contract: HumanAssistanceContract,
  ) => options.withPage(session, async (page) => {
    const descriptor = await options.resolveImage(page, contract);
    if (!descriptor) return null;
    const source = await inspectCaptchaImageSource(descriptor);
    return { descriptor, source };
  });

  const makeCapture = async (
    session: string,
    contract: HumanAssistanceContract,
  ): Promise<CaptchaSourceCapture | null> => {
    const inspected = await inspect(session, contract);
    if (!inspected?.source || !geometryMatches(inspected.source, options)) return null;
    const sourceImage = imageFromDataUrl(inspected.source.dataUrl);
    if (!sourceImage) return null;
    return {
      image: sourceImage,
      fingerprint: fingerprintForCaptchaCapture({
        descriptor: inspected.descriptor,
        source: inspected.source,
        image: sourceImage,
      }),
    };
  };

  return {
    id: options.id,
    capture: makeCapture,
    isCurrent: async (session, contract, capture) => {
      const inspected = await inspect(session, contract);
      if (!inspected?.source || !geometryMatches(inspected.source, options)) return false;
      const sourceImage = imageFromDataUrl(inspected.source.dataUrl);
      if (!sourceImage) return false;
      return fingerprintMatches(
        fingerprintForCaptchaCapture({
          descriptor: inspected.descriptor,
          source: inspected.source,
          image: sourceImage,
        }),
        capture.fingerprint,
      );
    },
  };
}

/**
 * Own the capture record lifecycle. A record is consumed before freshness is
 * checked, so every validation outcome (including errors and mismatches) is
 * single-use and cannot be replayed by another owner.
 */
export function createCaptchaSourceFreshnessStore(
  resolveOwner: CaptchaSourceOwnerResolver,
): CaptchaSourceFreshnessStore {
  const records = new Map<string, CaptchaSourceCaptureRecord>();

  return {
    capture: async (session, contract, owner) => {
      records.delete(session);
      let capture: CaptchaSourceCapture | null = null;
      try {
        capture = await owner.capture(session, contract);
      } catch {
        capture = null;
      }
      if (!capture) return null;
      records.set(session, {
        session,
        stageId: contract.stageId,
        contractVersion: contract.version,
        ownerId: owner.id,
        capture,
      });
      return capture.image;
    },
    isCurrent: async (session, contract) => {
      const record = records.get(session);
      records.delete(session);
      if (!record || record.session !== session) return false;
      if (record.stageId !== contract.stageId || record.contractVersion !== contract.version) {
        return false;
      }
      const owner = resolveOwner(record.ownerId, contract);
      if (!owner || owner.id !== record.ownerId) return false;
      try {
        return await owner.isCurrent(session, contract, record.capture);
      } catch {
        return false;
      }
    },
    clear: (session) => {
      records.delete(session);
    },
  };
}
