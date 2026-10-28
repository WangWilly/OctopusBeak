# A source may declare a cooldown between CAPTCHA retry rounds

Status: accepted

Amends [ADR 0015](0015-bounded-captcha-retry-campaigns.md). Applies [ADR 0057](0057-verified-source-definition-owns-every-per-source-fact.md).

ADR 0015 says rounds "begin without an added retry delay". Fubon refuses a sign-in that follows the previous session within seconds, so commit 2193c6c4e made the coordinator wait 20 seconds before Fubon's next round. It kept that wait in a table keyed by the task id `"fubon-all-statements"`, so the coordinator held a fact about one source, and no ADR recorded the exception.

**Rounds still begin at once by default.** A source whose provider refuses back-to-back sign-ins declares `verification.retryCooldownMs` on its Verified Source definition. Fubon declares 20 000 ms. The coordinator reads the value through `captchaRetryCooldownMs(taskId)` and waits that long before admitting the next round. A cancellation, force-quit or shutdown during the wait ends the campaign as cancelled (ADR 0052). The cooldown never adds a round and never changes the three-round bound.
