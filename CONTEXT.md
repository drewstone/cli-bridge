# Runtime images

**Runtime default** is the named Docker reference selected by the shared runtime
image owner for configuration, the existing builder and admin publication.
Per-backend overrides take precedence. Its live image binding affects new pools;
existing slots retain their recorded immutable image IDs. _Avoid_: "default image
version", which confuses a mutable reference with its immutable binding.

**Default publication** is the explicit compare-and-swap of that configured
reference after a candidate passes the maintained runtime checks. Its durable
intent and readback belong to the existing slot transaction. It does not replace
other slots or delete predecessor images. _Avoid_: "roll all pools".
