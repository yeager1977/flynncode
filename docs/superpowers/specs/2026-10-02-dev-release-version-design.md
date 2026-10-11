# Development release-base versions

Approved format: `1.18.34-dev-<timestamp>` for this checkout, with the base read
from `packages/flynncode/package.json` rather than hard-coded.

The shared build generator will replace the `0.0.0` preview base with the
backend package's release version. Existing channel and timestamp formatting
remain intact. Desktop packaging and the embedded backend already consume this
generator, so both will use the same version. Explicit `OPENCODE_VERSION`
overrides and release bump behavior retain priority and existing semantics.

Verification will execute the real generator for default, development, beta,
and explicitly overridden versions, then check the script package's types.
The user will rebuild and install the desktop package.
