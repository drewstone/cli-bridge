# Bridge domain terms

**Configured provider** is the native backend or route namespace established by native status and configuration. A model alias, login to a different provider, or compatibility mapping does not establish it. Actual served model identity belongs to the turn receipt. _Avoid_: served provider inferred from a harness.

**Route authentication** is the native authentication fact scoped to the selected provider and invocation. A stored OAuth credential is configured; only authoritative native ready/status evidence is authenticated. Aggregate harness login does not authorize another provider. _Avoid_: subscription-ready inferred from any OAuth store.

**Subscription admission** is the dedicated Bridge policy that rechecks route authentication before each new or retained turn. It requires authenticated subscription evidence and emits one typed subscription_required refusal before provider dispatch; read, replay and cancel remain available.
