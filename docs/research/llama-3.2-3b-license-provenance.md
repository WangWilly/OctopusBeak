# Llama 3.2 3B license and third-party GGUF provenance

Date checked: 2026-08-03

## Decision summary

This is a product-support recommendation, not legal advice. Meta's license is a custom source-available license, not a standard permissive OSS license. Product counsel should confirm the final shipping posture, especially the third-party quantizer's rights and the financial-use interpretation of the Acceptable Use Policy (AUP).

| Artifact path | MVP recommendation | Boundary |
| --- | --- | --- |
| Bundle the exact `bartowski` GGUF inside the signed App | **Unsupported for MVP** | Meta's license permits redistribution subject to conditions, but the examined third-party repository does not provide a standalone `LICENSE` or `NOTICE`, does not pin the exact Meta source revision, and does not provide a reproducible build record. Do not put these third-party bytes into the notarized product until counsel and release engineering close that provenance gap. |
| App-managed download from a pinned upstream URL | **Conditional support as catalog candidate** | Pin the full Hugging Face commit, filename, byte size, and LFS SHA-256; present and record acceptance of the Llama 3.2 license/AUP before download; ship product attribution and notices; never call the artifact verified solely from repository metadata. |
| User-provided GGUF | **Supported as user-imported/unverified** | Apply the existing user attestation, hash, GGUF parse, device preflight, trial-load, warning, and host authority boundary. Do not claim provenance or license verification. An exact hash match may inherit only the catalog status already granted to that exact hash. |

The recommended pinned candidate is:

- Repository: [`bartowski/Llama-3.2-3B-Instruct-GGUF`](https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF)
- Immutable repository revision: [`5ab33fa94d1d04e903623ae72c95d1696f09f9e8`](https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/tree/5ab33fa94d1d04e903623ae72c95d1696f09f9e8)
- File: `Llama-3.2-3B-Instruct-Q4_K_M.gguf`
- Size: `2,019,377,696` bytes
- SHA-256: `6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff`

The revision, file size, and LFS SHA-256 are exposed by the [official Hugging Face model API at that exact revision](https://huggingface.co/api/models/bartowski/Llama-3.2-3B-Instruct-GGUF/revision/5ab33fa94d1d04e903623ae72c95d1696f09f9e8?blobs=true). Hugging Face documents that downloads can be pinned to a full commit hash; `main` is not an acceptable product identity ([download documentation](https://huggingface.co/docs/huggingface_hub/main/en/guides/download#from-specific-version)).

## What the Meta license requires

The controlling text examined is Meta's [Llama 3.2 Community License at the official model revision](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/0cb88a4f764b7a12671c53f0838cd831a0843b95/LICENSE.txt), together with the [official AUP](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/0cb88a4f764b7a12671c53f0838cd831a0843b95/USE_POLICY.md) and [official model card](https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/MODEL_CARD.md).

Material obligations:

- Using or distributing any portion of the Llama Materials constitutes acceptance of the agreement. The license grants limited rights to use, copy, modify, create derivative works, and redistribute, subject to its conditions ([license preamble and §1(a)](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/0cb88a4f764b7a12671c53f0838cd831a0843b95/LICENSE.txt)).
- A distributor of Llama Materials, derivatives, or a product/service containing them must provide a copy of the agreement and prominently display **“Built with Llama”** on a related website, UI, About page, blog post, or product documentation ([license §1(b)(i)](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/0cb88a4f764b7a12671c53f0838cd831a0843b95/LICENSE.txt)).
- Every distributed copy of the Llama Materials must retain Meta's prescribed attribution in a `Notice` text file ([license §1(b)(iii)](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/0cb88a4f764b7a12671c53f0838cd831a0843b95/LICENSE.txt)).
- Use must comply with applicable law, trade rules, and the incorporated AUP ([license §1(b)(iv)](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/0cb88a4f764b7a12671c53f0838cd831a0843b95/LICENSE.txt)).
- If Llama Materials or outputs are used to create, train, fine-tune, or otherwise improve another AI model that is distributed, the resulting model name must begin with **“Llama”** ([license §1(b)(i)](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/0cb88a4f764b7a12671c53f0838cd831a0843b95/LICENSE.txt)). OctopusBeak is a product name, not the name of a derived model, so this clause does not require renaming the App. Preserve the published artifact/model identity rather than inventing a name that obscures its Llama origin.
- If the licensee and its affiliates had more than 700 million monthly active users in the calendar month before the September 25, 2024 release date, the community license does not authorize use until Meta separately grants a license ([license §2](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/0cb88a4f764b7a12671c53f0838cd831a0843b95/LICENSE.txt)). This appears unlikely for OctopusBeak, but the publisher must record an organizational attestation; repository metadata cannot establish it.
- Meta may terminate for breach, and an IP claim described in §5(c) terminates the grant. Upon termination, the license requires deletion and cessation of use ([license §§5(c), 6](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/0cb88a4f764b7a12671c53f0838cd831a0843b95/LICENSE.txt)). The license does not state a general at-will revocation right for compliant licensees, but the AUP points users to its “most recent” copy, so legal/compliance review remains a moving dependency ([AUP](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/0cb88a4f764b7a12671c53f0838cd831a0843b95/USE_POLICY.md)).

For this financial-data product, the AUP is not boilerplate. It prohibits unauthorized or unlicensed professional practice, expressly including financial practice, and restricts collection, processing, disclosure, generation, or inference of private or sensitive information without the legal right to do so. It also requires disclosure of known dangers to end users ([AUP, prohibited uses 1(c), 1(d), and 4](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/0cb88a4f764b7a12671c53f0838cd831a0843b95/USE_POLICY.md)). The product therefore needs a non-professional-advice boundary, lawful data-rights basis, and known-risk disclosure independent of artifact provenance.

## What the third-party repository proves

At immutable revision `5ab33fa94d1d04e903623ae72c95d1696f09f9e8`, the publisher's [commit-pinned model card](https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/blob/5ab33fa94d1d04e903623ae72c95d1696f09f9e8/README.md) states:

- `base_model: meta-llama/Llama-3.2-3B-Instruct`;
- `license: llama3.2`;
- `quantized_by: bartowski`;
- the original model is Meta's official Hugging Face repository;
- quantization used `llama.cpp` release `b3821`;
- all listed quantizations used an imatrix calibration dataset; and
- the Q4_K_M file is the non-split, approximately 2.02 GB option.

The [official Hugging Face API response for that revision](https://huggingface.co/api/models/bartowski/Llama-3.2-3B-Instruct-GGUF/revision/5ab33fa94d1d04e903623ae72c95d1696f09f9e8?blobs=true) independently fixes the repository commit, file list, byte sizes, and LFS content hashes. Hugging Face explains that model-card license and base-model fields are repository metadata supplied through the repository's `README.md`; they aid discovery but are publisher assertions, not a chain-of-custody attestation ([official model-card documentation](https://huggingface.co/docs/hub/model-cards#model-card-metadata)).

This evidence is sufficient to identify exact bytes and record the publisher's claimed recipe. It is **not** sufficient to establish a reproducible provenance chain:

- the card links the Meta repository but does not pin the exact Meta source revision or source-file hashes;
- it names a quantizer version and calibration dataset but does not include a complete build command, build log, or signed provenance attestation;
- the repository file list has no separate `LICENSE`, `LICENSE.txt`, `NOTICE`, or reproducibility manifest; the Llama license text is embedded in model-card metadata instead; and
- `license: llama3.2` is a publisher-maintained model-card field, not independent proof that all quantizer-owned contributions were licensed onward.

These are evidence limits, not findings that the publisher lacked authorization. Whether quantization adds separately protectable material, and whether the model-card license declaration grants all required third-party rights, are legal questions for counsel.

## Path-specific product contract

### 1. Signed-App bundle — unsupported for MVP

Bundling is direct redistribution by the App publisher. Before reconsidering it, release evidence must include:

1. counsel approval for the exact third-party artifact and quantizer rights;
2. the complete Llama 3.2 agreement and required Meta `Notice` in the distributed product;
3. a prominent “Built with Llama” attribution in product UI/About or documentation;
4. recorded 700M-MAU eligibility and AUP review;
5. the exact artifact revision, filename, size, and hash in the bundled catalog; and
6. an immutable provenance/build attestation stronger than the current repository card.

Benchmark success is runtime evidence only and cannot satisfy any of these authorization or provenance conditions.

### 2. App-managed pinned download — conditional catalog candidate

Use the immutable revision URL, not `main`, and require exact size/hash before atomic installation. Before download, the App should show the full license/AUP or a stable local copy plus direct links, require affirmative acceptance, and store the accepted license/disclosure version locally. The App/About documentation must carry “Built with Llama”; the installed artifact metadata must retain the prescribed Meta notice.

This path reduces the App-bundle redistribution footprint but does not erase the product's license and AUP duties: after installation the product contains and uses Llama Materials. It also does not cure the third-party derivation gap. Therefore the exact bartowski Q4_K_M may be a **catalog candidate**, not a verified or recommended artifact, until counsel accepts the evidence or a reproducible first-party quantization pipeline replaces it.

Pinned upstream availability is not guaranteed. Hugging Face documents that repository owners can delete repositories ([repository-management documentation](https://huggingface.co/docs/huggingface_hub/en/guides/repository)), while commit pinning only selects a particular revision for download ([download documentation](https://huggingface.co/docs/huggingface_hub/main/en/guides/download#from-specific-version)). The catalog must treat a failed/disabled upstream as unavailable, never silently substitute another file, and retain the already-decided sticky exact-hash revocation rule.

### 3. User-provided GGUF — supported as unverified

For an unknown hash, OctopusBeak should not assert who created the artifact, which Meta source revision it came from, whether the uploader had redistribution rights, or whether its filename is accurate. Require the existing local-use and license/provenance attestation; identify detected Llama artifacts to the user; present the Llama 3.2 license/AUP before first activation; retain the “unverified” badge and support diagnostics identity; and enforce the same host-owned safety and AUP boundary as catalog models.

If a user-provided file exactly matches a catalog hash, download channel does not change byte identity. It may inherit that exact catalog record's status, which for the examined bartowski Q4_K_M remains **candidate/conditional**, not verified. A different hash remains user-imported and unverified even if its filename is identical.

## Release gate

Llama 3.2 3B should remain **conditional**, not a default or verified MVP model, until the product has:

- implemented license acceptance, “Built with Llama,” Meta notice retention, and AUP disclosure;
- recorded the publisher's 700M-MAU eligibility;
- obtained counsel approval of the financial-use boundary and exact third-party quantizer rights; and
- either accepted the documented provenance gap for the pinned candidate or produced a reproducible GGUF from an authorized, pinned Meta source.

If baseline product compliance (license/AUP presentation, product attribution, lawful-use boundary, and MAU eligibility) is complete but the catalog-specific provenance/counsel gates are not, support only user-provided Llama GGUF as unverified artifacts under user attestation; do not bundle or catalog-download the bartowski artifact.
