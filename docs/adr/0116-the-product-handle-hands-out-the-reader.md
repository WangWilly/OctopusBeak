# The product handle hands out the reader

Status: accepted

Refines [ADR 0112](0112-one-reader-acquires-every-provider-response.md), which made one reader but left every caller to build it from the run's ports. Keeps product validation in the product handle ([ADR 0106](0106-the-product-handle-decides-what-is-a-validation-failure.md)).

## Context

After ADR 0112, about twenty-five collectors built `providerResponseReader({ now: () => context.now(), text: context.text, validate: product.validate })` by hand, and every Current-state snapshot call threaded `now`, `text`, `signal` and the product in again. A few varied: a local `now`, a separate text port, or `WITHOUT_PRODUCT_VALIDATION` where a product did own the read. Attached preview collectors received nothing, so each built one reader in a closure and shared it across products. Every sweep since ADR 0112 that changed how a read is bound had to touch each of these call sites.

## Decision

**A bank never builds a reader.** The Product collection run builds each product's handle with `productCollectionHandle`, which binds the handle's `reader` to the run clock, the run's text port and the handle's own `validate`, and carries the run's `signal`. A collector reads every response it owns through `product.reader`. The snapshot module takes the handle as its product and reads the clock, text, signal and reader from it.

**A read before any product goes through the Source reader.** `sourceReader(context)` is the reader for a source's session or sign-in reads. It carries no product validation, and it is the only place `WITHOUT_PRODUCT_VALIDATION` is used once every bank has moved.

**Each attached preview product gets its own handle.** A preview collector receives a `PreviewProductHandle` with its own Source reader and the run's signal, instead of sharing one reader a workflow built. A preview product has no product validation: the preview run classifies a refused response as that product's validation failure by its error, as it did before.

**Checks build handles the same way.** A check that drives a collector outside a run calls `productCollectionHandle`, so it exercises the binding the run uses.

**Banks move one at a time, then the old paths go.** Each bank's collectors move to the handle in their own change. Once every bank has moved, the snapshot module drops its threaded-ports form, `WITHOUT_PRODUCT_VALIDATION` and `ProviderResponsePorts` stop being exported, and a structural check keeps collectors from importing `providerResponseReader`.

## Considered options

- **Give the handle snapshot methods.** Rejected. The Product collection run would import the snapshot module and, through it, ledger command builders; passing the handle to the snapshot functions binds the same ports without that edge.
- **Put the Source reader on the workflow context.** Rejected for now. About forty checks build a context literal, and a function of the context binds the same ports.
- **Move every bank in one change, as ADR 0112 did.** Not chosen. Each bank's move is reviewed and verified against its own commit goldens; the temporary dual path in the snapshot module ends with the last bank.

## Consequences

- Until the last bank moves, the snapshot module accepts both forms.
- A preview product's reader is no longer shared with other preview products of the same run.
