# VidCreator project rules

## Interface icons

- Use **icons0 / Bootstrap Icons (`@icons0/bi`)** for interface icons throughout this project. Do not add emoji, Unicode pictograms, another icon library, or hand-drawn SVGs for controls. The VidCreator wordmark and branding are exceptions.
- Registry configuration lives in `package.json`: `@icons0` → `https://icons0.dev/r/{name}.json`. The collection is installed with `npx shadcn@latest add @icons0/bi`.
- This is a vanilla JavaScript app. Use the local SVG sprite in `public/icons/bi.svg` through `uiIcon(name)` for markup and `uiSetIcon(element, name)` for changing states. Do not add React or a CDN dependency to render icons.
- Add required icon names to `scripts/icons0-bi.json`, then run `npm run icons:update`. The importer runs shadcn in the ignored `runtime/icons0/` workspace and converts the selected registry components to a compact SVG sprite. Keep the license and source information.
- Use **Fill / solid icons only**. Outline icons are prohibited, including navigation, arrows, toolbars, notifications, and changing button states. Choose the Bootstrap `-fill` variant; when an exact Fill equivalent does not exist, use the closest meaningful solid icon. The sprite builder and `uiIcon()` reject names without `-fill`.
- Default size: 16px; navigation: 18px; editor tool rail: 20px. Use `currentColor`, consistent alignment, and the existing muted/lime palette.
- Decorative icons must be `aria-hidden="true"` and `focusable="false"`. Every icon-only button needs a Russian `aria-label` or descriptive `title`; preserve existing keyboard shortcuts, hit areas, focus indication, and event handlers.
- Do not transform user video titles, project names, subtitle text, or video overlays into icons. These rules apply to application chrome only.

## Validation

For interface-only icon changes, check JavaScript syntax and the affected screens in the browser, including play/pause, sound, dynamic lists, and narrow layouts. Keep changes scoped to presentation.
