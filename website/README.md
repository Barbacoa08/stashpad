# Scratchtree landing page

Build with `pnpm build:site`. This copies the pinned `@barbajoe/css-lib` stylesheet and the existing synthetic editor overview into `website/dist`. The website has no browser JavaScript or analytics.

`release.json` owns the download asset, release notes, and observed tested environment. Update it when publishing an authorized app release, after verifying the DMG and platform evidence. The development screenshot is labeled separately from the downloadable release.

The favicon and header use unchanged 16px, 32px, and 32px-at-2x PNG representations from the approved native ICNS. The build reads those PNG payloads directly, preserving their size mapping and artwork. See the [branding record](../docs/branding/README.md).

Netlify publishes only `website/dist`. The account-check function and private server settings are outside that directory. Its private `SCRATCHTREE_ALLOWED_EMAILS` list is an eligibility check; Dexie still verifies OTPs and restricts account access. Adding a future account requires updating both that list and Dexie’s registered users. No Dexie management credentials are needed by this endpoint.
